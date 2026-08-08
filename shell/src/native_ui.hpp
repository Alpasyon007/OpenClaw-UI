// Native UI the sidecar cannot provide: file dialogs and screen capture.
//
// These are the last five channels of the Electron surface. They stay in C++
// for the same reason the window does — a modal dialog needs an owner HWND, and
// a screen capture needs the desktop DC. Everything else lives in Node.

#pragma once

#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <commdlg.h>
#include <shlobj.h>
#include <objbase.h>
#include <gdiplus.h>
#endif

namespace shell::ui
{
#ifdef _WIN32

    namespace detail
    {
        inline std::string narrow(const std::wstring &w)
        {
            if (w.empty()) return {};
            const auto n = WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
            std::string out(std::size_t(n), '\0');
            WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), out.data(), n, nullptr, nullptr);
            return out;
        }

        inline std::wstring widen(const std::string &s)
        {
            if (s.empty()) return {};
            const auto n = MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0);
            std::wstring out(std::size_t(n), L'\0');
            MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), out.data(), n);
            return out;
        }
    } // namespace detail

    /// Folder picker. Returns "" if cancelled.
    inline std::string pick_folder(HWND owner)
    {
        // SHBrowseForFolder rather than IFileOpenDialog+FOS_PICKFOLDERS: no COM
        // apartment requirements to get wrong on whichever thread saucer runs
        // exposed functions on.
        wchar_t display[MAX_PATH]{};
        BROWSEINFOW bi{};
        bi.hwndOwner      = owner;
        bi.pszDisplayName = display;
        bi.lpszTitle      = L"Select a working directory";
        bi.ulFlags        = BIF_RETURNONLYFSDIRS | BIF_USENEWUI | BIF_NONEWFOLDERBUTTON;

        auto *idl = SHBrowseForFolderW(&bi);
        if (!idl) return {};

        wchar_t path[MAX_PATH]{};
        const auto ok = SHGetPathFromIDListW(idl, path);
        CoTaskMemFree(idl);
        return ok ? detail::narrow(path) : std::string{};
    }

    /// Multi-select open dialog. Empty vector if cancelled.
    inline std::vector<std::string> pick_files(HWND owner)
    {
        // Room for many paths: the buffer holds the directory followed by
        // NUL-separated file names when multi-select is used.
        std::vector<wchar_t> buffer(64 * 1024, L'\0');

        OPENFILENAMEW ofn{};
        ofn.lStructSize = sizeof(ofn);
        ofn.hwndOwner   = owner;
        ofn.lpstrFile   = buffer.data();
        ofn.nMaxFile    = DWORD(buffer.size());
        ofn.lpstrTitle  = L"Attach files";
        ofn.lpstrFilter = L"All files\0*.*\0";
        ofn.Flags = OFN_EXPLORER | OFN_ALLOWMULTISELECT | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;

        if (!GetOpenFileNameW(&ofn)) return {};

        // Single selection: one NUL-terminated full path. Multiple: directory,
        // NUL, then each file name, NUL, terminated by a double NUL.
        std::vector<std::string> out;
        const wchar_t *p = buffer.data();
        std::wstring first{p};
        p += first.size() + 1;

        if (*p == L'\0')
        {
            out.push_back(detail::narrow(first));
            return out;
        }

        while (*p != L'\0')
        {
            std::wstring name{p};
            p += name.size() + 1;
            out.push_back(detail::narrow(first + L"\\" + name));
        }
        return out;
    }

    /// Save dialog. Returns "" if cancelled.
    inline std::string save_file(HWND owner, const std::string &suggested, const std::string &filter_label,
                                 const std::string &filter_pattern)
    {
        auto name = detail::widen(suggested);
        name.resize(MAX_PATH, L'\0');

        // The filter is a double-NUL-terminated list of NUL-separated pairs, so
        // it cannot be built with ordinary string concatenation.
        std::wstring filter = detail::widen(filter_label);
        filter.push_back(L'\0');
        filter += detail::widen(filter_pattern);
        filter.push_back(L'\0');
        filter.push_back(L'\0');

        OPENFILENAMEW ofn{};
        ofn.lStructSize = sizeof(ofn);
        ofn.hwndOwner   = owner;
        ofn.lpstrFile   = name.data();
        ofn.nMaxFile    = MAX_PATH;
        ofn.lpstrFilter = filter.c_str();
        ofn.Flags       = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR;

        if (!GetSaveFileNameW(&ofn)) return {};
        return detail::narrow(name.c_str());
    }

    /// Single-file open dialog. Returns "" if cancelled.
    inline std::string open_file(HWND owner, const std::string &filter_label,
                                const std::string &filter_pattern)
    {
        std::wstring name(MAX_PATH, L'\0');

        std::wstring filter = detail::widen(filter_label);
        filter.push_back(L'\0');
        filter += detail::widen(filter_pattern);
        filter.push_back(L'\0');
        filter.push_back(L'\0');

        OPENFILENAMEW ofn{};
        ofn.lStructSize = sizeof(ofn);
        ofn.hwndOwner   = owner;
        ofn.lpstrFile   = name.data();
        ofn.nMaxFile    = MAX_PATH;
        ofn.lpstrFilter = filter.c_str();
        ofn.Flags       = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;

        if (!GetOpenFileNameW(&ofn)) return {};
        return detail::narrow(name.c_str());
    }

    /// Capture the whole virtual desktop to a PNG. Returns the path, or "".
    ///
    /// Under Electron this channel shelled out to /usr/sbin/screencapture, so it
    /// never worked on Windows at all — this implements it rather than ports it.
    inline std::string capture_screen(const std::string &out_path)
    {
        using namespace Gdiplus;

        // saucer already links gdiplus, but does not initialise it for us.
        GdiplusStartupInput gdip_in{};
        ULONG_PTR gdip_token{};
        if (GdiplusStartup(&gdip_token, &gdip_in, nullptr) != Ok) return {};

        struct Guard
        {
            ULONG_PTR token;
            ~Guard() { GdiplusShutdown(token); }
        } guard{gdip_token};

        const auto x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        const auto y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        const auto w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        const auto h = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        auto *screen_dc = GetDC(nullptr);
        auto *mem_dc    = CreateCompatibleDC(screen_dc);
        auto *bitmap    = CreateCompatibleBitmap(screen_dc, w, h);
        auto *previous  = SelectObject(mem_dc, bitmap);

        BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);

        std::string result;
        {
            Bitmap image{bitmap, nullptr};
            CLSID png{};
            // PNG encoder CLSID. Hardcoded rather than enumerated: the encoder
            // list is stable and enumeration is a lot of code for one constant.
            if (CLSIDFromString(L"{557CF406-1A04-11D3-9A73-0000F81EF32E}", &png) == NOERROR)
            {
                if (image.Save(detail::widen(out_path).c_str(), &png, nullptr) == Ok)
                {
                    result = out_path;
                }
            }
        }

        SelectObject(mem_dc, previous);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(nullptr, screen_dc);

        return result;
    }

#else

    inline std::string pick_folder(void *) { return {}; }
    inline std::vector<std::string> pick_files(void *) { return {}; }
    inline std::string save_file(void *, const std::string &, const std::string &, const std::string &) { return {}; }
    inline std::string open_file(void *, const std::string &, const std::string &) { return {}; }
    inline std::string capture_screen(const std::string &) { return {}; }

#endif
} // namespace shell::ui
