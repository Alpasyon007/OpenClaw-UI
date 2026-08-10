// Node sidecar transport for the saucer shell.
//
// Spawns `node <script>` with stdin/stdout redirected to pipes and speaks
// newline-delimited JSON over them. Nothing here understands the messages: it
// moves whole lines in both directions and hands received lines to a callback.
// Keeping the transport free of protocol lets the shell forward the existing
// IPC surface verbatim rather than re-modelling 57 channels in C++.

#pragma once

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

namespace shell
{
    class sidecar
    {
      public:
        using line_handler = std::function<void(std::string)>;

        sidecar()  = default;
        ~sidecar() { stop(); }

        sidecar(const sidecar &)            = delete;
        sidecar &operator=(const sidecar &) = delete;

        /// Launch `node script`. Returns false with `error` set on failure.
        bool start(const std::string &script, line_handler on_line, std::string &error);

        /// Queue one line to the sidecar's stdin. Appends the newline itself.
        bool send(std::string_view json);

        void stop();

        [[nodiscard]] bool running() const { return m_running.load(std::memory_order_relaxed); }

      private:
#ifdef _WIN32
        HANDLE m_child_stdin{nullptr};   // our write end
        HANDLE m_child_stdout{nullptr};  // our read end
        HANDLE m_process{nullptr};
#endif
        std::atomic_bool m_running{false};
        std::thread m_reader;
        std::mutex m_write_mutex;
        line_handler m_on_line;
    };

#ifdef _WIN32

    inline bool sidecar::start(const std::string &script, line_handler on_line, std::string &error)
    {
        m_on_line = std::move(on_line);

        const auto log_path = std::wstring{script.begin(), script.end()} + L".log";

        SECURITY_ATTRIBUTES sa{.nLength = sizeof(SECURITY_ATTRIBUTES), .bInheritHandle = TRUE};

        HANDLE in_read{}, in_write{}, out_read{}, out_write{};

        if (!CreatePipe(&in_read, &in_write, &sa, 0) || !CreatePipe(&out_read, &out_write, &sa, 0))
        {
            error = "CreatePipe failed";
            return false;
        }

        // Only the child's ends may be inherited, or the pipes never report EOF
        // when the child exits and the reader thread hangs forever.
        SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{.cb = sizeof(STARTUPINFOW)};
        si.dwFlags    = STARTF_USESTDHANDLES;
        si.hStdInput  = in_read;
        si.hStdOutput = out_write;
        // The sidecar logs to stderr, which goes nowhere in a GUI-subsystem app.
        // Send it to a file next to the executable so its diagnostics survive.
        // Never to stdout, which carries the protocol.
        SECURITY_ATTRIBUTES log_sa{.nLength = sizeof(SECURITY_ATTRIBUTES), .bInheritHandle = TRUE};
        auto *log_file = CreateFileW(log_path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     &log_sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        si.hStdError = log_file != INVALID_HANDLE_VALUE ? log_file : GetStdHandle(STD_ERROR_HANDLE);

        // lpApplicationName is null so PATH is searched for node.exe.
        auto command = std::wstring{L"node \""} + std::wstring{script.begin(), script.end()} + L"\"";

        PROCESS_INFORMATION pi{};
        const auto ok = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                       CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);

        // The child owns these now.
        CloseHandle(in_read);
        CloseHandle(out_write);

        if (!ok)
        {
            error = "CreateProcessW failed, code " + std::to_string(GetLastError()) +
                    " (is node on PATH?)";
            CloseHandle(in_write);
            CloseHandle(out_read);
            return false;
        }

        CloseHandle(pi.hThread);
        m_process      = pi.hProcess;
        m_child_stdin  = in_write;
        m_child_stdout = out_read;
        m_running.store(true, std::memory_order_relaxed);

        m_reader = std::thread{[this]
        {
            std::string buffer;
            char chunk[4096];

            while (m_running.load(std::memory_order_relaxed))
            {
                DWORD read{};
                if (!ReadFile(m_child_stdout, chunk, sizeof(chunk), &read, nullptr) || read == 0)
                {
                    break;  // pipe closed: the sidecar exited
                }

                buffer.append(chunk, read);

                // Emit whole lines only; a read can split a JSON message.
                std::size_t nl{};
                while ((nl = buffer.find('\n')) != std::string::npos)
                {
                    auto line = buffer.substr(0, nl);
                    buffer.erase(0, nl + 1);
                    if (!line.empty() && line.back() == '\r')
                    {
                        line.pop_back();
                    }
                    if (!line.empty() && m_on_line)
                    {
                        m_on_line(std::move(line));
                    }
                }
            }

            m_running.store(false, std::memory_order_relaxed);
        }};

        return true;
    }

    inline bool sidecar::send(std::string_view json)
    {
        if (!m_running.load(std::memory_order_relaxed) || !m_child_stdin)
        {
            return false;
        }

        std::string payload{json};
        payload.push_back('\n');

        std::scoped_lock lock{m_write_mutex};
        DWORD written{};
        return WriteFile(m_child_stdin, payload.data(), static_cast<DWORD>(payload.size()), &written,
                         nullptr) != 0;
    }

    inline void sidecar::stop()
    {
        if (!m_running.exchange(false, std::memory_order_relaxed) && !m_process)
        {
            return;
        }

        // Closing stdin is the cooperative shutdown: the sidecar's readline
        // 'close' handler exits. Only then force it.
        if (m_child_stdin)
        {
            CloseHandle(m_child_stdin);
            m_child_stdin = nullptr;
        }

        if (m_process)
        {
            if (WaitForSingleObject(m_process, 1500) == WAIT_TIMEOUT)
            {
                TerminateProcess(m_process, 0);
            }
            CloseHandle(m_process);
            m_process = nullptr;
        }

        if (m_child_stdout)
        {
            CloseHandle(m_child_stdout);
            m_child_stdout = nullptr;
        }

        if (m_reader.joinable())
        {
            m_reader.join();
        }
    }

#else

    inline bool sidecar::start(const std::string &, line_handler, std::string &error)
    {
        error = "sidecar transport is Windows-only in this spike";
        return false;
    }
    inline bool sidecar::send(std::string_view) { return false; }
    inline void sidecar::stop() {}

#endif
} // namespace shell
