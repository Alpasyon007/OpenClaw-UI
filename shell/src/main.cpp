// OpenClaw launcher shell — saucer feasibility spike.
//
// The launcher is a large, almost entirely transparent window with a small
// interactive bar near the bottom. Clicks outside the bar must reach whatever
// is underneath; clicks on the bar must not.
//
// Electron does this with setIgnoreMouseEvents(ignore, {forward: true}): the
// renderer keeps receiving mousemove even while the window is click-through,
// so it can hit-test its own DOM and decide when to become interactive again.
//
// saucer has only window::set_click_through(bool), with no forwarding. Once
// it is on, the page receives nothing and can never ask for input back —
// measured: 68 pointer events with it off, zero after enabling it, including
// on the sweep back onto the bar.
//
// The way out is to stop asking the page. GetCursorPos reports the pointer
// regardless of any window's input state, so the hit-test moves into C++: the
// page publishes the rectangles it wants to be interactive, and a poller
// compares the cursor against them and toggles click-through. The page never
// needs to see the pointer at all.

#include <atomic>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <filesystem>

#include <saucer/smartview.hpp>

#include "sidecar.hpp"

#ifdef _WIN32
#include <windows.h>
// stable_natives<window> is only forward-declared by the core headers; the
// backend header is what defines it (and its HWND member).
#include <saucer/modules/stable/webview2.hpp>
#endif

namespace fs = std::filesystem;

namespace
{
    constexpr auto kTransparent = saucer::color{.r = 0, .g = 0, .b = 0, .a = 0};

    // Matches the Electron launcher's geometry.
    constexpr int kWinWidth     = 1040;
    constexpr int kWinHeight    = 720;
    constexpr int kBottomMargin = 24;

    fs::path exe_dir()
    {
#ifdef _WIN32
        wchar_t buffer[MAX_PATH]{};
        GetModuleFileNameW(nullptr, buffer, MAX_PATH);
        return fs::path{buffer}.parent_path();
#else
        return fs::current_path();
#endif
    }

    void trace(std::string_view msg)
    {
        const auto path = (exe_dir() / "spike.log").string();
        if (FILE *f = std::fopen(path.c_str(), "a"))
        {
            std::fprintf(f, "%.*s\n", static_cast<int>(msg.size()), msg.data());
            std::fclose(f);
        }
    }

    /// Interactive regions, in CSS pixels relative to the window's client area.
    struct hit_regions
    {
        std::mutex mutex;
        std::vector<saucer::bounds> rects;
    };
} // namespace

coco::stray start(saucer::application *app)
{
    auto window = saucer::window::create(app).value();
    auto view   = saucer::smartview::create({.window = window});

    if (!view.has_value())
    {
        co_return trace(std::string{"smartview::create failed: "} + view.error().message());
    }

    static hit_regions regions;
    static std::atomic_bool running{true};

    // The page hands us its interactive rectangles as a flat [x,y,w,h,...]
    // list whenever its layout changes — not per mouse move, so this stays
    // quiet once the UI has settled.
    view->expose("set_hit_rects",
                 [](std::vector<int> flat)
                 {
                     std::scoped_lock lock{regions.mutex};
                     regions.rects.clear();
                     for (std::size_t i = 0; i + 3 < flat.size(); i += 4)
                     {
                         regions.rects.push_back({flat[i], flat[i + 1], flat[i + 2], flat[i + 3]});
                     }
                     trace("hit rects: " + std::to_string(regions.rects.size()));
                 });

    window->set_title("OpenClaw (saucer spike)");
    window->set_size({.w = kWinWidth, .h = kWinHeight});

    // Position on the PRIMARY monitor's work area.
    //
    // saucer's screen list is not primary-first and its screen struct has no
    // work area at all, so it cannot place a launcher above the taskbar. Worse,
    // win32.app.impl.cpp reads rcMonitor.top into .x and .left into .y, which
    // is transposed and only looks right on a primary monitor where both are 0.
    // Ask Win32 directly instead: this window was landing at x=-216, straddling
    // two monitors.
#ifdef _WIN32
    {
        MONITORINFO mi{.cbSize = sizeof(MONITORINFO)};
        const auto primary = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
        if (GetMonitorInfoW(primary, &mi))
        {
            const auto work = mi.rcWork;
            window->set_position({
                .x = work.left + ((work.right - work.left) - kWinWidth) / 2,
                .y = work.bottom - kWinHeight - kBottomMargin,
            });
            trace("primary work area " + std::to_string(work.left) + "," + std::to_string(work.top) +
                  " " + std::to_string(work.right - work.left) + "x" +
                  std::to_string(work.bottom - work.top));
        }
    }
#endif

    window->set_decorations(saucer::window::decoration::none);
    window->set_always_on_top(true);
    window->set_background(kTransparent);
    view->set_background(kTransparent);
    // DevTools on demand: CLUI_DEVTOOLS=1 (it covers the launcher when open).
    if (const char *dt = std::getenv("CLUI_DEVTOOLS"); dt && *dt == char(49)) view->set_dev_tools(true);

    const auto index = saucer::url::from(exe_dir() / "index.html");
    if (!index.has_value())
    {
        co_return trace(std::string{"url::from failed: "} + index.error().message());
    }

    // ─── Node sidecar ───
    //
    // The shell forwards opaque JSON lines in both directions and never parses
    // the protocol. That is what keeps the port tractable: the existing
    // handlers stay on Node, and adding a channel touches no C++ at all.
    static shell::sidecar bridge;

    // Page -> sidecar. Fire-and-forget; replies come back asynchronously below,
    // which is also how a request/response API is built on a one-way pair.
    // Page diagnostics. The GUI subsystem has no console and DevTools is not
    // always practical, so the page reports boot progress and uncaught errors
    // into the same trace file the shell uses.
    view->expose("shell_log", [](std::string msg) { trace("[page] " + msg); });

    view->expose("bridge_send",
                 [](std::string line)
                 {
                     if (!bridge.send(line))
                     {
                         trace("bridge_send dropped (sidecar not running)");
                     }
                 });

    {
        const auto script = (exe_dir() / "sidecar" / "main.mjs").string();
        std::string err;

        // The sidecar serves the page from here; keep the two in agreement.
        _putenv_s("CLUI_WEB_ROOT", exe_dir().string().c_str());

        // Sidecar -> page. The reader thread is not the UI thread, so hop via
        // post() before touching the webview. Capture a pointer, not a
        // reference to the local result<>.
        auto *vp = &view.value();

        // Navigation waits for the sidecar's first line, which it emits only
        // after its loopback server is listening. WebView2 will not load
        // subresources over file://, so the page must come from http://.
        static std::atomic_bool navigated{false};

        const auto deliver = [app, vp](std::string line)
        {
            if (!navigated.exchange(true))
            {
                app->post([vp]
                          {
                              const auto url = "http://127.0.0.1:17817/index.html";
                              trace(std::string{"navigating to "} + url);
                              vp->set_url(url);
                          });
            }

            app->post([vp, line = std::move(line)]
                      {
                          // smartview::execute is a FORMAT function, not a plain
                          // eval — it shadows webview::execute(cstring_view).
                          // Splicing raw JSON into the format string would have
                          // every '{' in the payload read as a format specifier,
                          // so the line goes through as an argument and the
                          // serializer quotes and escapes it. The page parses.
                          vp->execute("window.__bridgeReceive && window.__bridgeReceive({})", line);
                      });
        };

        if (!bridge.start(script, deliver, err))
        {
            trace("sidecar failed to start: " + err);
        }
        else
        {
            trace("sidecar started: " + script);
        }
    }

    view->set_url(index.value());
    window->show();

#ifdef _WIN32
    // Cursor poller. Runs off the UI thread, marshals every state change back
    // through app->post() because window methods must touch the UI thread.
    //
    // Polling rather than a WH_MOUSE_LL hook on purpose: a low-level hook is
    // global, runs in every input message's path, and is silently dropped by
    // Windows if it ever overruns its timeout. This costs one GetCursorPos per
    // frame and cannot affect other applications.
    const auto hwnd = window->native().hwnd;
    std::thread{[app, window, hwnd]
                {
                    bool click_through = false;
                    bool initialised   = false;

                    while (running.load(std::memory_order_relaxed))
                    {
                        POINT p{};
                        RECT r{};
                        if (GetCursorPos(&p) && GetWindowRect(hwnd, &r))
                        {
                            // Client-relative, and DPI-correct: derive the scale
                            // from the window rather than assuming 96dpi.
                            const auto dpi   = static_cast<double>(GetDpiForWindow(hwnd));
                            const auto scale = dpi > 0 ? dpi / 96.0 : 1.0;
                            const auto cx    = static_cast<int>((p.x - r.left) / scale);
                            const auto cy    = static_cast<int>((p.y - r.top) / scale);

                            bool over = false;
                            {
                                std::scoped_lock lock{regions.mutex};
                                for (const auto &b : regions.rects)
                                {
                                    if (cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.h)
                                    {
                                        over = true;
                                        break;
                                    }
                                }
                            }

                            // Interactive over a published rect, click-through
                            // everywhere else.
                            if (const bool want = !over; want != click_through || !initialised)
                            {
                                click_through = want;
                                initialised   = true;
                                trace(std::string{"cursor "} + std::to_string(cx) + "," +
                                      std::to_string(cy) + " -> click_through=" +
                                      (want ? "true" : "false"));
                                app->post([window, want] { window->set_click_through(want); });
                            }
                        }

                        std::this_thread::sleep_for(std::chrono::milliseconds(16));
                    }
                }}
        .detach();
#endif

#ifdef _WIN32
    {
        RECT wr{};
        if (GetWindowRect(window->native().hwnd, &wr))
        {
            trace("winrect " + std::to_string(wr.left) + "," + std::to_string(wr.top) + " " +
                  std::to_string(wr.right - wr.left) + "x" + std::to_string(wr.bottom - wr.top));
        }
    }
#endif

#ifdef _WIN32
    // ─── Summon / dismiss ───
    //
    // Mirrors the Electron launcher's handshake, which exists for a measured
    // reason: revealing the window before the renderer has settled makes the bar
    // visibly assemble itself. So the page is told to prepare while off screen,
    // it acks once its layout has stopped moving, and only then does the window
    // move into view. Dismissal is the same in reverse — the exit animation
    // finishes before the window is parked.
    //
    // Parking off-screen rather than hide()/show() for the same reason it was
    // needed under Electron: hide() tears the renderer down far enough that the
    // reveal lands mid-layout.
    static std::atomic_int present_gen{0};
    static std::atomic_int dismiss_gen{0};
    static std::atomic_bool launcher_on_screen{true};
    static saucer::position on_screen_pos{};
    static int park_x = 0;

    {
        const auto pos = window->position();
        on_screen_pos = pos;
        // Just past the leftmost monitor: off every screen, but an ordinary
        // coordinate. Far-left extremes like -32000 sit near the 16-bit floor
        // that legacy WM_MOVE packs into and drew a corrupt titlebar.
        park_x = GetSystemMetrics(SM_XVIRTUALSCREEN) - kWinWidth - 100;
    }

    auto *evp = &view.value();
    const auto send_event = [app, evp](std::string channel, std::string payload_json)
    {
        app->post([evp, channel = std::move(channel), payload_json = std::move(payload_json)]
                  {
                      const auto json = "{\"event\":\"" + channel + "\",\"payload\":" + payload_json + "}";
                      evp->execute("window.__bridgeReceive({})", json);
                  });
    };

    const auto reveal = [app, window, send_event](int gen)
    {
        // Consume the generation so the ack and the watchdog cannot both fire.
        int expected = gen;
        if (!present_gen.compare_exchange_strong(expected, 0)) return;
        if (launcher_on_screen.exchange(true)) return;
        app->post([window] { window->set_position(on_screen_pos); window->focus(); });
        send_event("clui:window-shown", "null");
        trace("reveal gen=" + std::to_string(gen));
    };

    const auto park = [app, window](int gen)
    {
        int expected = gen;
        if (!dismiss_gen.compare_exchange_strong(expected, 0)) return;
        if (launcher_on_screen.load()) return;
        app->post([window] { window->set_position({.x = park_x, .y = on_screen_pos.y}); });
        trace("parked gen=" + std::to_string(gen));
    };

    // Acks from the page. clui.windowReady/dismissReady are routed here by the
    // shim rather than to the sidecar, since they are window concerns.
    view->expose("window_ready", [reveal](int gen) { reveal(gen); });
    view->expose("dismiss_ready", [park](int gen) { park(gen); });

    const auto summon = [send_event, reveal]
    {
        if (launcher_on_screen.load()) return;
        const auto gen = ++present_gen;
        send_event("clui:window-prepare", std::to_string(gen));
        // A wedged renderer must never make the launcher unsummonable.
        std::thread{[gen, reveal] {
            std::this_thread::sleep_for(std::chrono::milliseconds(450));
            reveal(gen);
        }}.detach();
    };

    const auto dismiss = [send_event, park]
    {
        if (!launcher_on_screen.load()) return;
        launcher_on_screen.store(false);
        const auto gen = ++dismiss_gen;
        send_event("clui:window-dismiss", std::to_string(gen));
        std::thread{[gen, park] {
            std::this_thread::sleep_for(std::chrono::milliseconds(260));
            park(gen);
        }}.detach();
    };

    // ─── Global shortcuts ───
    //
    // Electron provided these via globalShortcut.register; saucer has no
    // equivalent, so register them with Win32 directly. RegisterHotKey delivers
    // WM_HOTKEY to the registering thread, so this owns a small message loop of
    // its own rather than trying to hook saucer's.
    //
    // Accelerators match src/shared/shortcuts.ts: Alt+Space and Ctrl+Shift+K
    // both toggle the launcher.
    std::thread{[app, window, summon, dismiss]
                {
                    constexpr int kAltSpace = 1;
                    constexpr int kCtrlShiftK = 2;

                    const bool alt_space = RegisterHotKey(nullptr, kAltSpace, MOD_ALT | MOD_NOREPEAT, VK_SPACE);
                    const bool ctrl_k = RegisterHotKey(nullptr, kCtrlShiftK,
                                                       MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, 0x4B);
                    trace(std::string{"hotkeys: Alt+Space="} + (alt_space ? "ok" : "FAILED") +
                          " Ctrl+Shift+K=" + (ctrl_k ? "ok" : "FAILED"));

                    MSG msg{};
                    while (running.load(std::memory_order_relaxed) && GetMessageW(&msg, nullptr, 0, 0))
                    {
                        if (msg.message != WM_HOTKEY)
                        {
                            continue;
                        }

                        trace(std::string{"hotkey toggle; on_screen="} +
                              (launcher_on_screen.load() ? "1" : "0"));
                        if (launcher_on_screen.load())
                        {
                            dismiss();
                        }
                        else
                        {
                            summon();
                        }
                    }

                    UnregisterHotKey(nullptr, kAltSpace);
                    UnregisterHotKey(nullptr, kCtrlShiftK);
                }}
        .detach();
#endif

    trace("shown; polling cursor for hit-testing");
    co_await app->finish();
    running.store(false, std::memory_order_relaxed);
    bridge.stop();
}

int main()
{
    trace("--- main() entered ---");

    auto app = saucer::application::create({.id = "openclaw-shell"});
    if (!app.has_value())
    {
        trace(std::string{"application::create failed: "} + app.error().message());
        return 1;
    }

    return app->run(start);
}
