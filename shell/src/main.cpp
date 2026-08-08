// OpenClaw launcher shell — saucer feasibility spike.
//
// Cut back to the smallest thing that is known to work, to isolate why the
// window was created but never became visible. Additions go back one at a
// time from here.

#include <cstdio>
#include <string>
#include <filesystem>

#include <saucer/smartview.hpp>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace
{
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
} // namespace

coco::stray start(saucer::application *app)
{
    static constexpr auto transparent = saucer::color{.r = 0, .g = 0, .b = 0, .a = 0};

    auto window  = saucer::window::create(app).value();
    auto webview = saucer::smartview::create({.window = window});

    if (!webview.has_value())
    {
        co_return trace(std::string{"smartview::create failed: "} + webview.error().message());
    }

    // The decisive test. Electron's setIgnoreMouseEvents(ignore, {forward:true})
    // keeps delivering mousemove while the window is click-through, which is
    // what lets the page decide when to become interactive again. saucer has
    // only the boolean. If the page stops receiving pointer events once this
    // is enabled, it can never ask for them back and the launcher is inert.
    webview->expose("set_click_through",
                    [window](bool enabled)
                    {
                        window->set_click_through(enabled);
                        trace(std::string{"set_click_through("} + (enabled ? "true" : "false") + ")");
                    });

    // Called from JS on every mousemove. Whether these keep arriving after
    // click-through is enabled is the entire question.
    webview->expose("pointer", [](int x, int y) {
        trace("pointer " + std::to_string(x) + "," + std::to_string(y));
    });

    window->set_title("saucer minimal");
    window->set_size({.w = 480, .h = 320});
    window->set_position({.x = 100, .y = 100});

    window->set_decorations(saucer::window::decoration::none);
    window->set_always_on_top(true);

    window->set_background(transparent);
    webview->set_background(transparent);

    const auto index = saucer::url::from(exe_dir() / "index.html");
    if (!index.has_value())
    {
        co_return trace(std::string{"url::from failed: "} + index.error().message());
    }

    webview->set_url(index.value());
    window->show();

    // Ask saucer what it thinks the window is, rather than inferring it from
    // an HWND found by class name outside the process.
    {
        const auto sz  = window->size();
        const auto pos = window->position();
        trace("visible=" + std::string{window->visible() ? "true" : "false"}
              + " size=" + std::to_string(sz.w) + "x" + std::to_string(sz.h)
              + " pos=" + std::to_string(pos.x) + "," + std::to_string(pos.y)
              + " topmost=" + (window->always_on_top() ? "true" : "false")
              + " title='" + std::string{window->title()} + "'");
    }

    co_await app->finish();
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
