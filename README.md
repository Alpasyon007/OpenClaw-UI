# OpenClaw UI



A lightweight,  desktop overlay for OpenClaw. This fork focuses on one-command deploy, app-style installation, and OpenClaw-first onboarding/control workflows.
  
> Attribution: this project is a fork of [lcoutodemos/clui-cc](https://github.com/lcoutodemos/clui-cc), with original foundation by [lcoutodemos](https://github.com/lcoutodemos).

![OpenClaw UI Banner](resources/openclaw-ui-banner.svg)

<img width="925" height="675" alt="Screenshot 2026-03-25 at 5 58 24 PM" src="https://github.com/user-attachments/assets/bf8eb9ec-9fd6-410c-9537-f4fedf6530bf" />

<img width="721" height="568" alt="Screenshot 2026-03-25 at 5 58 09 PM" src="https://github.com/user-attachments/assets/943c30c1-3eed-4398-ab2c-3dd0b1552498" />


## Features

- **Floating overlay** — a click-through window that stays on top. Toggle with `⌥ + Space` (fallback: `Cmd+Shift+K`).
- **Multi-tab sessions** — each tab runs its own OpenClaw TUI session with independent state.
- **Conversation history** — browse and resume past OpenClaw sessions.
- **Skills marketplace** — install plugins from Anthropic's GitHub repos without leaving OpenClaw UI.
- **Visual skill builder** — node-style skill composition panel (When/Time/What/Where/Search/Action) that generates a structured build prompt.
- **Voice input** — local speech-to-text via Whisper (required, installed automatically).
- **File & screenshot attachments** — paste images or attach files directly.

## Why OpenClaw UI

- **OpenClaw, but visual✨✨** — keep CLI power while getting a fast desktop UX for approvals, history, and multitasking.
- **Human-in-the-loop safety** — tool calls are reviewed and approved in-app by YOU, yes you before execution.
- **Session-native workflow** — each tab runs an independent OpenClaw session you can resume later but is still connected to the same openclaw agent lol
- **Local-first** — everything runs through your local OpenClaw CLI. No network needed (unless your using a provider for the ai model*)


## How It Works

```
UI prompt → Node sidecar spawns openclaw tui --message
        → PTY stream parser → live render
        → tool call? → permission UI given to the user → approve/deny
```

The desktop shell is a small C++ [saucer](https://github.com/saucer/saucer) app
that owns the window layer — frameless, transparent, always-on-top, tray icon,
global hotkeys and cursor hit-testing for click-through. Everything else runs in
a Node sidecar it speaks to over NDJSON on stdio, and the UI is the same React
bundle served to the webview over loopback.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full deep-dive.

## Build From Source

Windows is the supported platform today — the shell targets WebView2 and the
node host integrates with a Scheduled Task.

**Prerequisites:** Node 20+, CMake 3.21+, and a C++20 toolchain (MSVC via
Visual Studio Build Tools). WebView2 ships with Windows 11.

```bash
git clone https://github.com/MuhammadDaudNasir/OpenClaw-UI.git
```

```bash
cd OpenClaw-UI && npm install
```

```bash
npm run dist
```

That runs the whole chain — renderer, generated bridge, sidecar bundle, then the
C++ shell — and stages a self-contained folder in `release/`. The first run also
configures CMake, which fetches saucer and takes a few minutes.

> Press **⌥ + Space** to show/hide the overlay. If another app claims that combo,
> use **Cmd/Ctrl+Shift+K**.

<p align="center"><img src="docs/shortcut.png" width="520" alt="Press Option + Space to show or hide OpenClaw UI" /></p>

<details>
<summary><strong>Developer Commands</strong></summary>

### Working on the UI only

```bash
npm run dev
```

Plain Vite dev server with hot reload. `window.clui` is not present there, so
anything that talks to the backend is inert — it is for layout and styling work.

### Working on the backend

```bash
npm run dist:web
```

Rebuilds everything except the C++ shell — renderer, bridge and sidecar — which
is all you need unless you changed `shell/src`. Needs no C++ toolchain.

### Command reference

| Command | Purpose |
|---------|---------|
| `npm run dist` | Full build → `release/` (needs CMake + C++ toolchain) |
| `npm run dist:web` | Everything except the C++ shell |
| `npm run build` | Renderer bundle only → `dist/renderer` |
| `npm run shim` | Regenerate `window.clui` from the contract |
| `npm run sidecar` | Bundle the Node sidecar → `shell/sidecar/main.cjs` |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `sidecar/` |
| `npm run doctor` | Environment diagnostic |
| `./commands/bootstrap.command` | Environment check + install + renderer build |
| `./commands/setup-git.command --origin <url>` | Set your GitHub remote for this fork |

### The bridge contract

`window.clui` is **generated**, not hand-written. `src/shared/clui-contract.ts`
declares every channel; `sidecar/gen-shim.mjs` reads it and emits
`shell/web/clui-shim.js`. Add a method to the contract and run `npm run shim` —
if the channel is not in `src/shared/types.ts`, generation fails loudly rather
than shipping a bridge that silently resolves to `undefined`.

</details>

## Publish Your Fork To GitHub

Use the helper:

```bash
./commands/setup-git.command --origin https://github.com/<you>/<repo>.git
git push -u origin $(git rev-parse --abbrev-ref HEAD)
```

Full guide: [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)

## Platform Status

Windows is the platform the saucer shell currently targets: WebView2 for the
webview, ConPTY for the agent transport, and a Scheduled Task for the node host.

macOS and Linux are not built yet. saucer itself is cross-platform (WebKit on
both), so the gap is in `shell/src` — the tray, hotkey and click-through paths
are written against Win32. Nothing in the sidecar or the renderer is
Windows-specific.

CI (`.github/workflows/windows-smoke.yml`) runs the typecheck, the renderer
build, bridge generation and the sidecar bundle on `windows-latest`. It does not
build the C++ shell.

Detailed guide: [`docs/WINDOWS.md`](docs/WINDOWS.md)

<details>
<summary><strong>Setup Prerequisites (Detailed)</strong></summary>

You need **macOS 13+**. Then install these one at a time — copy each command and paste it into Terminal.

**Step 1.** Install Xcode Command Line Tools (needed to compile native modules):

```bash
xcode-select --install
```

**Step 2.** Install Node.js (recommended: current LTS such as 20 or 22; minimum supported: 18). Download from [nodejs.org](https://nodejs.org), or use Homebrew:

```bash
brew install node
```

Verify it's on your PATH:

```bash
node --version
```

**Step 3.** Make sure Python has `setuptools` (needed by the native module compiler). On Python 3.12+ this is missing by default:

```bash
python3 -m pip install --upgrade pip setuptools
```

**Step 4.** Install OpenClaw CLI (or keep Claude CLI for compatibility mode):

```bash
# Install your OpenClaw CLI package/binary here
```

**Step 5.** Authenticate OpenClaw (follow the prompts that appear):

```bash
openclaw
```

**Step 6.** Install Whisper for voice input:

```bash
# Apple Silicon (M1/M2/M3/M4) — preferred:
brew install whisperkit-cli
# Apple Silicon fallback, or Intel Mac:
brew install whisper-cpp
```

> **No API keys or `.env` file required.** OpenClaw UI uses your existing OpenClaw CLI authentication (Pro/Team/Enterprise subscription).

</details>

<details>
<summary><strong>Architecture and Internals</strong></summary>

### Project Structure

```
shell/                      # C++ saucer app — owns the window layer
├── src/main.cpp            # Window, tray, hotkeys, click-through hit-testing
├── src/sidecar.hpp         # Spawns Node, duplex NDJSON over stdio
├── src/native_ui.hpp       # File dialogs + screen capture (needs an HWND)
├── web/                    # Built renderer + generated clui-shim.js
└── CMakeLists.txt

sidecar/                    # Node backend — everything that is not the window
├── index.ts                # Channel table; imports the modules below
└── gen-shim.mjs            # Emits shell/web/clui-shim.js from the contract

src/
├── main/                   # Backend modules, shared with the sidecar
│   ├── claude/             # ControlPlane, RunManagers, EventNormalizer
│   ├── hooks/              # PermissionServer (PreToolUse HTTP hooks)
│   ├── marketplace/        # Plugin catalog fetching + install
│   ├── skills/             # Skill auto-installer
│   ├── cli-probe.ts        # Throttled + cached CLI probing
│   └── openclaw/runtime.ts # Locates and invokes the CLI
├── renderer/               # React frontend
│   ├── components/         # TabStrip, ConversationView, InputBar, etc.
│   ├── stores/             # Zustand session store
│   ├── hooks/              # Event listeners, health reconciliation
│   └── theme.ts            # Dual palette + CSS custom properties
└── shared/
    ├── types.ts            # Canonical types, IPC channel definitions
    └── clui-contract.ts    # The window.clui contract the shim is generated from
```

### How It Works

1. Each tab creates an `openclaw tui --message ... --session ...` process.
2. PTY output is parsed and normalized into canonical UI events.
3. `ControlPlane` manages tab lifecycle (connecting → idle → running → completed/failed/dead).
4. Tool permission requests arrive via HTTP hooks to `PermissionServer` (localhost only).
5. The renderer polls backend health every 1.5s and reconciles tab state.
6. Sessions are resumed with `--resume <session-id>` for continuity.

### Network Behavior

OpenClaw UI operates almost entirely offline. The only outbound network calls are:

| Endpoint | Purpose | Required |
|----------|---------|----------|
| `raw.githubusercontent.com/anthropics/*` | Marketplace catalog (cached 5 min) | No — graceful fallback |
| `api.github.com/repos/anthropics/*/tarball/*` | Skill auto-install on startup | No — skipped on failure |

No telemetry, analytics, or auto-update mechanisms. All core OpenClaw interaction goes through the local CLI.

</details>

## Troubleshooting

For setup issues and recovery commands, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

Quick self-check:

```bash
npm run doctor
```

## Tested On

| Component | Version |
|-----------|---------|
| Windows | 11 (WebView2) |
| Node.js | 20.x LTS, 22.x, 24.x |
| CMake | 3.21+ with MSVC (C++20) |
| OpenClaw CLI | 2026.7.x |

## Known Limitations

- **Windows only for now** — the saucer shell's tray, hotkey and click-through paths are written against Win32. See [Platform Status](#platform-status).
- **Requires OpenClaw CLI** — OpenClaw UI is a UI layer, not a standalone AI client. You need an authenticated `openclaw` CLI.
- **Permission mode** — OpenClaw runs through PTY/TUI transport so approvals and tool execution remain interactive.

## Credits

- Fork and active development: [Muhammad Daud Nasir](https://github.com/MuhammadDaudNasir)
- Original project and core foundation: [lcoutodemos](https://github.com/lcoutodemos) ([clui-cc](https://github.com/lcoutodemos/clui-cc))
- This fork keeps explicit attribution in docs and UI.

## License

[MIT](LICENSE)
