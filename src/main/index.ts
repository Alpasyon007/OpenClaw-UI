import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences } from 'electron'
import { join, basename, isAbsolute, sep } from 'path'
import { existsSync, mkdtempSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync, renameSync } from 'fs'
import { createInterface } from 'readline'
import { homedir, tmpdir } from 'os'
import { ControlPlane } from './claude/control-plane'
import { cliInvocation, getCliRuntime, getAgentDataHomes } from './openclaw/runtime'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { getCliEnv } from './cli-env'
import { IPC } from '../shared/types'
import { getShortcuts, type ShortcutId } from '../shared/shortcuts'
import { validateTheme, THEME_FILE_KIND, THEME_FILE_VERSION, type ThemeFile } from '../shared/theme-types'
import type {
  RunOptions,
  NormalizedEvent,
  EnrichedError,
  ConnectionTarget,
  GatewayConfigView,
  NodeAction,
  NodeHostStatus,
} from '../shared/types'

const IS_WIN = process.platform === 'win32'

const DEBUG_MODE = process.env.CLUI_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.CLUI_SPACES_DEBUG === '1'

function log(msg: string): void {
  _log('main', msg)
}

// ─── Path + CLI helpers ───

/**
 * Reject relative paths and paths carrying control characters.
 * Replaces the old `startsWith('/')` checks, which rejected every valid
 * Windows path and so silently disabled the handlers that used them.
 */
function isSafeAbsolutePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !/[\0\r\n]/.test(p) && isAbsolute(p)
}

/**
 * Encode a working directory the way the CLI names its session folder.
 * Path separators and the Windows drive colon all collapse to '-', so
 * `C:\Dev\OpenClaw-UI` becomes `C--Dev-OpenClaw-UI`.
 */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-')
}

/**
 * Locate a session directory for a project path.
 * Windows drive letters appear in either case on disk, so fall back to a
 * case-insensitive scan before giving up.
 */
function findSessionDir(cwd: string): string | null {
  const encoded = encodeProjectDir(cwd)
  for (const home of getAgentDataHomes()) {
    const exact = join(home, 'projects', encoded)
    if (existsSync(exact)) return exact
  }
  if (!IS_WIN) return null

  const wanted = encoded.toLowerCase()
  for (const home of getAgentDataHomes()) {
    const root = join(home, 'projects')
    if (!existsSync(root)) continue
    try {
      const match = readdirSync(root).find((d) => d.toLowerCase() === wanted)
      if (match) return join(root, match)
    } catch {
      // Unreadable projects root — try the next home.
    }
  }
  return null
}

/**
 * Strip credential-shaped values out of CLI output before it crosses IPC.
 *
 * `openclaw node status` echoes the service's full environment block, which
 * includes OPENCLAW_GATEWAY_TOKEN in plaintext. The renderer pipes this
 * straight into a <pre>, so it must never arrive with the value intact.
 */
function redactSecrets(text: string): string {
  if (!text) return text
  return text
    // KEY=value / "KEY": "value" for anything token/secret/password/key-shaped
    .replace(
      /((?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*"?)([^\s"',}]+)/gi,
      '$1<redacted>',
    )
    .replace(/("(?:token|secret|password|apiKey|privateKey)"\s*:\s*")([^"]+)/gi, '$1<redacted>')
    // Bare 64-hex strings are gateway tokens in this codebase.
    .replace(/\b[a-f0-9]{64}\b/gi, '<redacted>')
}

/**
 * Sample CPU utilisation from cpu-time deltas.
 * `os.loadavg()` returns zeros on Windows, so the previous implementation
 * always reported 0% there.
 */
let lastCpuSample: { idle: number; total: number } | null = null
function sampleCpuPercent(): number {
  const os = require('os') as typeof import('os')
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value as number
      if (kind === 'idle') idle += value as number
    }
  }

  const prev = lastCpuSample
  lastCpuSample = { idle, total }
  if (!prev) return 0

  const idleDelta = idle - prev.idle
  const totalDelta = total - prev.total
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)))
}

/** Run the CLI synchronously. Never throws; failures come back structured. */
function runCliSync(
  args: string[],
  timeoutMs = 15000,
): { ok: boolean; stdout: string; stderr: string } {
  const { execFileSync } = require('child_process')
  const { command, args: full } = cliInvocation(args)
  try {
    const stdout = String(
      execFileSync(command, full, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        env: getCliEnv(getCliRuntime().extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).trim()
    return { ok: true, stdout, stderr: '' }
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || '').trim(),
    }
  }
}

/**
 * Run the CLI without blocking the main thread.
 *
 * The synchronous variant freezes the entire Electron main process for the
 * duration — measured at ~3.5s even for `--version` — which stalls IPC, PTY
 * event forwarding, and rendering. Anything on a poll or triggered by a button
 * must use this instead.
 */
function runCliAsync(
  args: string[],
  timeoutMs = 20000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { execFile } = require('child_process')
  const { command, args: full } = cliInvocation(args)
  return new Promise((resolve) => {
    execFile(
      command,
      full,
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        env: getCliEnv({ ...getCliRuntime().extraEnv, ...extraEnv }),
        maxBuffer: 8 * 1024 * 1024,
      },
      (err: any, stdout: string, stderr: string) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || err?.message || '').trim(),
        })
      },
    )
  })
}

/** Async runner for a binary that is not the resolved CLI (e.g. clawhub). */
function runBinAsync(
  bin: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { execFile } = require('child_process')
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { encoding: 'utf-8', timeout: timeoutMs, env: getCliEnv(), maxBuffer: 8 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || err?.message || '').trim(),
        })
      },
    )
  })
}

/**
 * Open a command in the platform's terminal.
 * The macOS path drives Terminal.app via AppleScript; Windows uses cmd.exe's
 * `start` so the console stays open after the CLI exits.
 */
function openInPlatformTerminal(cwd: string, argv: string[]): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = require('child_process')

  return new Promise((resolve) => {
    if (IS_WIN) {
      const comspec = process.env.ComSpec || 'cmd.exe'

      // `start` hands its tail back to cmd.exe, which re-parses it. Escaping
      // metacharacters reliably through two layers of quoting rules is not
      // worth attempting — refuse instead. Legitimate paths and UUIDs never
      // contain these.
      const unsafe = argv.find((a) => /["&|<>^%]/.test(a))
      if (unsafe) {
        resolve({ ok: false, error: `Refusing to open a terminal: argument contains shell metacharacters (${unsafe})` })
        return
      }
      if (/["&|<>^%]/.test(cwd)) {
        resolve({ ok: false, error: `Refusing to open a terminal: working directory contains shell metacharacters (${cwd})` })
        return
      }

      // cmd.exe's /C and /K quote-stripping rules mean neither Node's own
      // argument quoting nor a naive pre-join survives a program path
      // containing spaces (i.e. C:\Program Files\nodejs\node.exe). The one
      // form that works — verified empirically against the alternatives — is
      // a hand-built verbatim command line where /S tells cmd to strip
      // exactly the outer quote pair and treat the remainder literally.
      //
      // The working directory goes through the spawn options, never onto the
      // command line, so a path cannot inject a second command. /K keeps the
      // console open after the CLI exits.
      const quoted = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
      execFile(
        comspec,
        [`/c start "" ${comspec} /s /k "${quoted}"`],
        { cwd, windowsVerbatimArguments: true },
        (err: Error | null) => resolve(err ? { ok: false, error: err.message } : { ok: true }),
      )
      return
    }

    if (process.platform === 'darwin') {
      const shellSingleQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
      const escapeAppleScript = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const cmd = `cd ${shellSingleQuote(cwd)} && ${argv.map(shellSingleQuote).join(' ')}`
      const script = `tell application "Terminal"\n  activate\n  do script "${escapeAppleScript(cmd)}"\nend tell`
      execFile('/usr/bin/osascript', ['-e', script], (err: Error | null) =>
        resolve(err ? { ok: false, error: err.message } : { ok: true }),
      )
      return
    }

    // Linux: try the common terminal emulators in order.
    const shellSingleQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
    const inner = `cd ${shellSingleQuote(cwd)} && ${argv.map(shellSingleQuote).join(' ')}; exec $SHELL`
    const emulators = [
      ['x-terminal-emulator', ['-e', 'sh', '-c', inner]],
      ['gnome-terminal', ['--', 'sh', '-c', inner]],
      ['konsole', ['-e', 'sh', '-c', inner]],
      ['xterm', ['-e', 'sh', '-c', inner]],
    ] as Array<[string, string[]]>

    let i = 0
    const tryNext = (): void => {
      if (i >= emulators.length) {
        resolve({ ok: false, error: 'No supported terminal emulator found' })
        return
      }
      const [bin, args] = emulators[i++]
      execFile(bin, args, (err: Error | null) => (err ? tryNext() : resolve({ ok: true })))
    }
    tryNext()
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let toggleSequence = 0

/**
 * How long after an intentional show() to ignore blur-driven auto-hide.
 * Covers the window where Windows has not yet settled foreground activation.
 */
const SHOW_FOCUS_GRACE_MS = 600
/** How long to wait before treating a blur as a real click-away. */
const BLUR_HIDE_CONFIRM_MS = 180
/**
 * Minimum gap between honoured launcher toggles. A measured trace showed a
 * single press producing five fires in 48ms, flickering the window
 * hide/show/hide/show/hide.
 */
const TOGGLE_DEBOUNCE_MS = 250
let lastShowAt = 0

/**
 * Reveal-after-prepare state.
 *
 * Each summon gets a generation so a stale ack from a superseded summon cannot
 * reveal the window, and so a dismiss can cancel an in-flight reveal.
 */
let presentGeneration = 0
let presentTimer: ReturnType<typeof setTimeout> | null = null
let pendingReveal: { generation: number; reveal: (why: string) => void } | null = null
/**
 * Reveal anyway if the renderer never acks — a wedged renderer must not trap
 * the launcher.
 *
 * Must stay above the renderer's own settle cap (SETTLE_CAP_MS = 320 in
 * App.tsx). At the old 160ms this watchdog fired *during* the renderer's
 * layout settle and revealed a half-built shell — which is the bar visibly
 * assembling on summon.
 */
const PRESENT_ACK_TIMEOUT_MS = 450

/** Abandon any in-flight reveal (called when the window is dismissed). */
function cancelPendingReveal(): void {
  if (presentTimer) { clearTimeout(presentTimer); presentTimer = null }
  if (pendingReveal) {
    presentGeneration++
    pendingReveal = null
  }
}

// ─── Visibility: park off-screen rather than hide/show ───
//
// Windows animates every ShowWindow — MinAnimate defaults to 1 — and on this
// transparent frameless window that OS transition IS the summon animation.
// It is not ours: with every renderer animation forcibly disabled, a frame
// probe across six summons found the DOM byte-identical on all 226 sampled
// frames (position, size, opacity, transform), spanning the reveal. Nothing in
// React, framer-motion or CSS moves during a summon. The one way not to play
// the OS transition is to never call ShowWindow.
//
// So the window is shown exactly once, at startup, and stays shown for the
// process lifetime. Dismissing drops it to zero alpha, summoning restores it,
// and an opacity change carries no transition.
//
// Parking by moving the window off-screen was tried first and drew a corrupt
// titlebar: on a transparent frameless window a move triggers a non-client
// recalc, and the far-left park coordinate sat near the 16-bit signed floor
// that legacy WM_MOVE paths pack coordinates into. Alpha never touches window
// position, so the non-client area is never recalculated. Repositioning for a
// summon still happens — but while alpha is 0, so it cannot be seen.
//
// Consequence: isVisible() is permanently true and useless as a guard, so the
// idempotence checks that relied on it read launcherVisible instead. Set
// CLUI_LEGACY_HIDE=1 to fall back to real hide()/show().
type Bounds = { x: number; y: number; width: number; height: number }

// Real hide()/show() is now the fallback, reachable with CLUI_LEGACY_HIDE=1.
//
// hide() tears the renderer down far enough that the window is revealed before
// layout has finished, and the user watches the bar assemble — measured in two
// independent screen recordings as 48x9 -> 646x53 -> 663x56 -> 700x89 over
// ~200ms. Gating the reveal cannot fix it, because the layout only completes
// as a consequence of being shown.
//
// Parking off-screen keeps the renderer continuously live and painted, so a
// summon is a single move of an already-finished window.
//
// Two earlier attempts at this failed for reasons that were not the approach:
// parking at x=-32000 sat near the 16-bit floor that legacy WM_MOVE packs
// coordinates into and drew a corrupt titlebar, and setOpacity(0) is
// unreliable on a transparent window and left it permanently unrendered.
// Park just beyond the leftmost display instead — far off-screen, nowhere
// near any coordinate limit, and no alpha involved.
const LEGACY_HIDE = process.env.CLUI_LEGACY_HIDE === '1'
let launcherVisible = false
let lastVisibleBounds: Bounds | null = null

/**
 * Dismissal is a handshake, not an instant move: the renderer plays its exit
 * and acks, then the window is parked. Generation-tagged so a summon landing
 * mid-exit cannot be followed by a stale park.
 */
let dismissGeneration = 0
let pendingDismiss: number | null = null
let dismissTimer: ReturnType<typeof setTimeout> | null = null
/** Park anyway if the renderer never acks. Must exceed the exit duration. */
const DISMISS_ACK_TIMEOUT_MS = 260

/** True when the launcher is actually on screen, under either model. */
function isLauncherVisible(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return LEGACY_HIDE ? mainWindow.isVisible() : launcherVisible
}

/** Take the launcher off screen without a window-manager transition. */
function hideLauncher(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (LEGACY_HIDE) {
    mainWindow.hide()
    return
  }
  if (!launcherVisible) return

  // Treat the launcher as gone the instant dismissal starts, so a hotkey
  // pressed during the exit re-summons rather than queueing a second dismiss.
  launcherVisible = false

  const generation = ++dismissGeneration
  pendingDismiss = generation
  if (dismissTimer) clearTimeout(dismissTimer)
  // A renderer that never acks must not strand the launcher on screen.
  dismissTimer = setTimeout(() => parkLauncher(generation, 'watchdog'), DISMISS_ACK_TIMEOUT_MS)
  broadcast(IPC.WINDOW_DISMISS, generation)
}

/** Abandon an in-flight dismissal — the user summoned again mid-exit. */
function cancelPendingDismiss(): void {
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null }
  pendingDismiss = null
  dismissGeneration++
}

/** Actually move the window off-screen. Only ever called once per dismissal. */
function parkLauncher(generation: number, why: string): void {
  if (pendingDismiss !== generation) return
  pendingDismiss = null
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null }
  if (!mainWindow || mainWindow.isDestroyed()) return
  // A summon landed while the exit was playing — leave it where it is.
  if (launcherVisible) return

  const current = mainWindow.getBounds()
  lastVisibleBounds = { ...current }

  // Just past the leftmost display, so it is off every screen while staying a
  // small, ordinary coordinate.
  const leftmost = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x))
  const parkX = leftmost - current.width - 100

  mainWindow.setBounds({ ...current, x: parkX })
  // Off-screen but still visible to the OS, so make sure it cannot swallow
  // clicks aimed at whatever is underneath.
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  if (SPACES_DEBUG) log(`[spaces] parked off-screen at x=${parkX} via ${why}`)
}

/** Bring the launcher on screen at `target` and take foreground. */
function showLauncher(target: Bounds): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  launcherVisible = true
  lastVisibleBounds = { ...target }
  // Under the parked model this single move IS the reveal: the window was
  // never hidden, so its renderer is already live, laid out and painted.
  mainWindow.setBounds(target)
  if (LEGACY_HIDE) mainWindow.show()
  // The window never stopped being visible, but it did lose foreground when
  // the user clicked away, so activation still has to be asked for.
  mainWindow.focus()
  mainWindow.webContents.focus()
}

// Feature flag: PTY transport default.
// Note: if CLI is OpenClaw, PTY is forced regardless of this flag.
const INTERACTIVE_PTY = process.env.CLUI_INTERACTIVE_PERMISSIONS_PTY !== '0'

/**
 * Only one copy may run.
 *
 * Without this, a second launch registers the same global accelerators, so one
 * keypress toggles the launcher once per running copy — the window flickers
 * open/closed and reads as the summon animation playing twice. A second launch
 * now just summons the existing window instead.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow('second instance'))
}

const controlPlane = new ControlPlane(INTERACTIVE_PTY)

type OpenclawConfig = {
  models?: {
    providers?: Record<string, { models?: Array<{ id?: string; name?: string }> }>
  }
  agents?: {
    defaults?: {
      model?: {
        primary?: string
        fallbacks?: string[]
      }
    }
  }
  gateway?: {
    /**
     * The key the CLI actually reads when deciding whether to route remotely.
     * `gateway.remote.enabled` is accepted by the schema but read by nothing —
     * setting it alone leaves every run pointed at local loopback.
     */
    mode?: 'local' | 'remote'
    bind?: string
    remote?: {
      enabled?: boolean
      url?: string
      token?: { source?: string; provider?: string; id?: string }
    }
  }
}

function openclawConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json')
}

function readOpenclawConfig(): OpenclawConfig {
  const path = openclawConfigPath()
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw)
}

/**
 * Write openclaw.json atomically.
 *
 * The CLI writes this file too, so a partial write from a truncating
 * whole-file rewrite can leave it unparseable for both processes.
 * Write to a sibling temp file and rename, which is atomic within a volume.
 */
function writeOpenclawConfig(config: OpenclawConfig): void {
  const path = openclawConfigPath()
  const content = JSON.stringify(config, null, 2) + '\n'
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, path)
}

// Keep native width fixed to avoid renderer animation vs setBounds race.
// The UI itself still launches in compact mode; extra width is transparent/click-through.
const BAR_WIDTH = 1040
const PILL_HEIGHT = 720  // Fixed native window height — extra room for expanded UI + shadow buffers
const PILL_BOTTOM_MARGIN = 24

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}


// ─── Wire ControlPlane events → renderer ───

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// ─── Window Creation ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: screenWidth, height: screenHeight } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const x = dx + Math.round((screenWidth - BAR_WIDTH) / 2)
  const y = dy + screenHeight - PILL_HEIGHT - PILL_BOTTOM_MARGIN

  mainWindow = new BrowserWindow({
    width: BAR_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // This window spends most of its life hidden and is summoned by a
      // shortcut. Chromium throttles hidden renderers — timers are clamped and
      // compositing is suspended — so the first frames after show() arrive
      // cold and the entrance animation visibly stutters. Keeping the renderer
      // warm costs idle CPU but is the point of a launcher.
      backgroundThrottling: false,
    },
    // Render the first frame while still hidden so show() has something
    // composited to present immediately.
    paintWhenInitiallyHidden: true,
  })

  // Belt-and-suspenders: panel already joins all spaces and floats,
  // but explicit flags ensure correct behavior on older Electron builds.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  mainWindow.once('ready-to-show', () => {
    // The only ShowWindow in the process lifetime. Every later dismiss/summon
    // moves the window instead, so the OS open transition plays at most once,
    // at startup, where there is nothing to be jarring about.
    mainWindow?.show()
    launcherVisible = true
    // Enable OS-level click-through for transparent regions.
    // { forward: true } ensures mousemove events still reach the renderer
    // so it can toggle click-through off when cursor enters interactive UI.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  let forceQuit = false
  app.on('before-quit', () => { forceQuit = true })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      hideLauncher()
    }
  })

  // Auto-hide when focus is lost (clicking another app/window).
  // Skip auto-hide while user is dragging files into the window.
  let isDragHolding = false
  ipcMain.on(IPC.DRAG_HOLDING, (_event, holding: boolean) => {
    isDragHolding = !!holding
  })
  // Windows does not reliably hand foreground activation to a background
  // process, so show() is often followed by a spurious blur/focus churn before
  // focus settles. Hiding on the raw blur made the launcher vanish
  // milliseconds after being summoned and then reappear — which reads as a
  // stutter, or as the animation playing twice.
  //
  // Rather than trusting a fixed timer, confirm the loss: wait a beat, and
  // only hide if we still do not have focus. A transient blur cancels itself
  // when focus returns, while a genuine click-away survives.
  let blurHideTimer: ReturnType<typeof setTimeout> | null = null
  const cancelPendingHide = (): void => {
    if (blurHideTimer) {
      clearTimeout(blurHideTimer)
      blurHideTimer = null
    }
  }

  mainWindow.on('focus', cancelPendingHide)
  mainWindow.on('show', cancelPendingHide)

  mainWindow.on('blur', () => {
    if (isDragHolding) return
    cancelPendingHide()
    blurHideTimer = setTimeout(() => {
      blurHideTimer = null
      if (forceQuit || !mainWindow || mainWindow.isDestroyed()) return
      // Focus came back — this was activation churn, not the user leaving.
      if (mainWindow.isFocused()) return
      // Still inside the activation window after an intentional summon.
      if (Date.now() - lastShowAt < SHOW_FOCUS_GRACE_MS) return
      if (isLauncherVisible()) hideLauncher()
      cancelPendingReveal()
    }, BLUR_HIDE_CONFIRM_MS)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(source = 'unknown'): void {
  if (!mainWindow) return

  // Already on screen: just take focus. Re-revealing a launcher that is
  // already up reads as it appearing a second time. Reachable from the tray
  // menu, a second instance launch, and any duplicate shortcut delivery.
  if (isLauncherVisible()) {
    lastShowAt = Date.now()
    if (!mainWindow.isFocused()) mainWindow.webContents.focus()
    if (SPACES_DEBUG) log(`[spaces] showWindow source=${source} skipped — already visible`)
    return
  }

  // Summoned mid-exit: the window is still on screen, so drop the pending park
  // rather than letting it fire after the entrance has already replayed.
  cancelPendingDismiss()

  const toggleId = ++toggleSequence

  // Position on the display where the cursor currently is (not always primary)
  // — all of this happens while the window is still hidden.
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea
  const target = {
    x: dx + Math.round((sw - BAR_WIDTH) / 2),
    y: dy + sh - PILL_HEIGHT - PILL_BOTTOM_MARGIN,
    width: BAR_WIDTH,
    height: PILL_HEIGHT,
  }
  // Only move when something actually changes. Re-applying identical bounds
  // still makes Chromium re-lay-out the viewport, which lands as a visible
  // redraw immediately after the window becomes visible.
  //
  // While parked, the horizontal position IS the reveal, so hold x off-screen
  // and settle only size and vertical position here — otherwise the launcher
  // would slide into view before the renderer had been told to prepare.
  const current = mainWindow.getBounds()
  const staged = LEGACY_HIDE ? target : { ...target, x: current.x }
  if (
    current.x !== staged.x || current.y !== staged.y
    || current.width !== staged.width || current.height !== staged.height
  ) {
    mainWindow.setBounds(staged)
  }

  // Spaces are a macOS concept. The flag can be lost across hide/show cycles
  // there and must be re-asserted before show(); on Windows and Linux the call
  // is pointless window churn on every summon.
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  if (SPACES_DEBUG) {
    log(`[spaces] showWindow#${toggleId} source=${source} move-to-display id=${display.id}`)
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  // ─── Prepare, then reveal ───
  //
  // WINDOW_SHOWN used to be broadcast AFTER show(), so the renderer ran
  // closeAuxPanels() and focused the input one to two frames after the window
  // was already on screen — the user saw it appear, then re-lay-out. That is
  // the "appears then jumps" report, and it is why fixes aimed at how the
  // summon was *triggered* never helped.
  //
  // The renderer is now told to settle FIRST, while still hidden, and the
  // window is revealed only once it acks that the change has painted. The
  // first visible frame is therefore the final frame.
  const generation = ++presentGeneration

  const reveal = (why: string): void => {
    // A newer summon or a dismiss superseded this one.
    if (generation !== presentGeneration) return
    // Consume the generation so a late ack cannot reveal a second time.
    presentGeneration++
    if (presentTimer) { clearTimeout(presentTimer); presentTimer = null }
    pendingReveal = null
    if (!mainWindow || mainWindow.isDestroyed() || isLauncherVisible()) return

    lastShowAt = Date.now()
    showLauncher(target)
    // Still emitted for consumers that only care about focus (the input bar).
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log(`[spaces] reveal#${toggleId} via ${why}`)
      scheduleToggleSnapshots(toggleId, 'show')
    }
  }

  pendingReveal = { generation, reveal }
  // A wedged or crashed renderer must never make the launcher unsummonable.
  // Clear first: a re-entrant summon would otherwise overwrite a live handle,
  // orphaning a watchdog that neither reveal() nor cancelPendingReveal() can
  // reach.
  if (presentTimer) clearTimeout(presentTimer)
  presentTimer = setTimeout(() => reveal('watchdog'), PRESENT_ACK_TIMEOUT_MS)
  broadcast(IPC.WINDOW_PREPARE, generation)
}

/**
 * Collapse repeat toggle requests from every source that can produce them.
 *
 * A single keypress was measured producing five fires within 48ms — faster
 * than Windows' maximum key-repeat rate — flickering the launcher
 * hide/show/hide/show/hide. The tray click can double up the same way when a
 * context menu is attached. A toggle is only meaningful once per intentional
 * interaction, so anything arriving inside the window is dropped.
 */
let lastToggleAt = 0
function debouncedToggle(source: string): void {
  const now = Date.now()
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    log(`Ignoring repeat toggle from ${source} (${now - lastToggleAt}ms since last)`)
    return
  }
  lastToggleAt = now
  toggleWindow(source)
}

/** Tray icon click — shares the toggle debounce with the accelerators. */
function trayToggle(): void {
  debouncedToggle('tray click')
}

function toggleWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (isLauncherVisible()) {
    cancelPendingReveal()
    hideLauncher()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showWindow(source)
  }
}

// ─── Resize ───
// Fixed-height mode: ignore renderer resize events to prevent jank.
// The native window stays at PILL_HEIGHT; all expand/collapse happens inside the renderer.

ipcMain.on(IPC.RESIZE_HEIGHT, () => {
  // No-op — fixed height window, no dynamic resize
})

ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {
  // No-op — native width is fixed to keep expand/collapse animation smooth.
})

ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
  // No-op — kept for API compat, animation handled purely in renderer
})

ipcMain.on(IPC.HIDE_WINDOW, () => {
  // Cancel first: a reveal armed microseconds ago would otherwise fire its
  // watchdog and re-show the window the user just dismissed.
  cancelPendingReveal()
  hideLauncher()
})

ipcMain.handle(IPC.IS_VISIBLE, () => {
  // Not isVisible(): under the parked model that is permanently true.
  return isLauncherVisible()
})

// OS-level click-through toggle — renderer calls this on mousemove
// to enable clicks on interactive UI while passing through transparent areas
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})

// ─── IPC Handlers (typed, strict) ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START — fetching static CLI info')
  const runtime = getCliRuntime()
  const cliCommand = runtime.kind
  log(`CLI runtime: ${runtime.label} (resolved=${runtime.resolved})`)

  const runCli = (args: string[]) => runCliSync(args, 5000)

  let version = 'unknown'
  const shortVersion = runCli(['-v'])
  if (shortVersion.ok && shortVersion.stdout) {
    version = shortVersion.stdout
  } else {
    const longVersion = runCli(['--version'])
    if (longVersion.ok && longVersion.stdout) version = longVersion.stdout
  }

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  let authSupported = true
  const authProbe = runCli(['auth', 'status'])
  if (authProbe.ok) {
    try { auth = JSON.parse(authProbe.stdout) } catch {}
  } else {
    const unknownCmd = /unknown command|did you mean/i.test(authProbe.stderr) || /unknown command|did you mean/i.test(authProbe.stdout)
    if (unknownCmd) authSupported = false
  }

  let mcpServers: string[] = []
  const mcpProbe = runCli(['mcp', 'list'])
  if (mcpProbe.ok && mcpProbe.stdout) {
    mcpServers = mcpProbe.stdout.split('\n').filter(Boolean)
  }
  const mcpSupported = mcpProbe.ok || !/unknown command|did you mean/i.test(mcpProbe.stderr + mcpProbe.stdout)

  return {
    version,
    auth,
    mcpServers,
    projectPath: process.cwd(),
    homePath: homedir(),
    cliBinary: runtime.label,
    cliCommand,
    authSupported,
    mcpSupported,
  }
})

ipcMain.handle(IPC.CREATE_TAB, () => {
  const tabId = controlPlane.createTab()
  log(`IPC CREATE_TAB → ${tabId}`)
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  log(`IPC INIT_SESSION: ${tabId}`)
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  log(`IPC RESET_TAB_SESSION: ${tabId}`)
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  if (DEBUG_MODE) {
    log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
  } else {
    log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  }

  if (!tabId) {
    throw new Error('No tabId provided — prompt rejected')
  }
  if (!requestId) {
    throw new Error('No requestId provided — prompt rejected')
  }

  try {
    await controlPlane.submitPrompt(tabId, requestId, options)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`PROMPT error: ${msg}`)
    throw err
  }
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
  log(`IPC CANCEL: ${requestId}`)
  return controlPlane.cancel(requestId)
})

ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
  log(`IPC STOP_TAB: ${tabId}`)
  return controlPlane.cancelTab(tabId)
})

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC RETRY: tab=${tabId} req=${requestId}`)
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.TAB_HEALTH, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
  log(`IPC CLOSE_TAB: ${tabId}`)
  controlPlane.closeTab(tabId)
})

ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, mode: string) => {
  if (mode !== 'ask' && mode !== 'auto') {
    log(`IPC SET_PERMISSION_MODE: invalid mode "${mode}" — ignoring`)
    return
  }
  log(`IPC SET_PERMISSION_MODE: ${mode}`)
  controlPlane.setPermissionMode(mode)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    // Validate projectPath — reject control characters and relative paths
    if (!isSafeAbsolutePath(cwd)) {
      log(`LIST_SESSIONS: rejected invalid projectPath: ${cwd}`)
      return []
    }
    // Session files live under ~/.openclaw/projects/<encoded-path>/ with legacy
    // fallback to ~/.claude/projects for migration compatibility.
    const sessionsDir = findSessionDir(cwd)
    if (!sessionsDir) {
      log(`LIST_SESSIONS: directory not found for ${encodeProjectDir(cwd)}`)
      return []
    }
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastTimestamp: string; size: number }> = []

    // UUID v4 regex — only consider files named as valid UUIDs
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    for (const file of files) {
      // The filename (without .jsonl) is the canonical resume ID for `<cli> --resume`
      const fileSessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(fileSessionId)) continue // skip non-UUID files

      const filePath = join(sessionsDir, file)
      const stat = statSync(filePath)
      if (stat.size < 100) continue // skip trivially small files

      // Read lines to extract metadata and validate transcript schema
      const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastTimestamp: string | null } = {
        validated: false, slug: null, firstMessage: null, lastTimestamp: null,
      }

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(filePath) })
        rl.on('line', (line: string) => {
          try {
            const obj = JSON.parse(line)
            // Validate: must have expected transcript fields
            if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
              meta.validated = true
            }
            if (obj.slug && !meta.slug) meta.slug = obj.slug
            if (obj.timestamp) meta.lastTimestamp = obj.timestamp
            if (obj.type === 'user' && !meta.firstMessage) {
              const content = obj.message?.content
              if (typeof content === 'string') {
                meta.firstMessage = content.substring(0, 100)
              } else if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text')
                meta.firstMessage = textPart?.text?.substring(0, 100) || null
              }
            }
          } catch {}
          // Read all lines to get the last timestamp
        })
        rl.on('close', () => resolve())
      })

      if (meta.validated) {
        sessions.push({
          sessionId: fileSessionId,
          slug: meta.slug,
          firstMessage: meta.firstMessage,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
          size: stat.size,
        })
      }
    }

    // Sort by last timestamp, most recent first
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    return sessions.slice(0, 20) // Return top 20
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// Load conversation history from a session's JSONL file
ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)

  // Validate sessionId — must be strict UUID to prevent path traversal via crafted filenames
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(sessionId)) {
    log(`LOAD_SESSION: rejected invalid sessionId: ${sessionId}`)
    return []
  }

  try {
    const cwd = projectPath || process.cwd()
    // Validate projectPath — reject control characters and relative paths
    if (!isSafeAbsolutePath(cwd)) {
      log(`LOAD_SESSION: rejected invalid projectPath: ${cwd}`)
      return []
    }
    const sessionsDir = findSessionDir(cwd)
    if (!sessionsDir) return []
    const filePath = join(sessionsDir, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    const messages: Array<{ role: string; content: string; toolName?: string; timestamp: number }> = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user') {
            const content = obj.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            }
            if (text) {
              messages.push({ role: 'user', content: text, timestamp: new Date(obj.timestamp).getTime() })
            }
          } else if (obj.type === 'assistant') {
            const content = obj.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push({ role: 'assistant', content: block.text, timestamp: new Date(obj.timestamp).getTime() })
                } else if (block.type === 'tool_use' && block.name) {
                  messages.push({
                    role: 'tool',
                    content: '',
                    toolName: block.name,
                    timestamp: new Date(obj.timestamp).getTime(),
                  })
                }
              }
            }
          }
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return messages
  } catch (err) {
    log(`LOAD_SESSION error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top (not behind other apps).
  // Unparented avoids modal dimming on the transparent overlay.
  // Activation is fine here — user is actively interacting with CLUI.
  if (process.platform === 'darwin') app.focus()
  const options = { properties: ['openDirectory'] as const }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  try {
    // Parse with URL constructor to reject malformed/ambiguous payloads
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (!parsed.hostname) return false
    await shell.openExternal(parsed.href)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.OPEN_PATH, async (_event, path: string) => {
  try {
    if (!isSafeAbsolutePath(path)) return false
    const result = await shell.openPath(path)
    return result === ''
  } catch {
    return false
  }
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top
  if (process.platform === 'darwin') app.focus()
  const options = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
    ],
  }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled || result.filePaths.length === 0) return null

  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  return result.filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    // Generate preview data URL for images (max 2MB to keep IPC fast)
    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
})

ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
  if (!mainWindow) return null

  if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
  const restoreTo = lastVisibleBounds
  hideLauncher()
  await new Promise((r) => setTimeout(r, 300))

  try {
    const { execSync } = require('child_process')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const { readFileSync, existsSync } = require('fs')

    const timestamp = Date.now()
    const screenshotPath = join(tmpdir(), `clui-screenshot-${timestamp}.png`)

    execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
      timeout: 30000,
      stdio: 'ignore',
    })

    if (!existsSync(screenshotPath)) {
      return null
    }

    // Return structured attachment with data URL preview
    const buf = readFileSync(screenshotPath)
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `screenshot ${++screenshotCounter}.png`,
      path: screenshotPath,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      size: buf.length,
    }
  } catch {
    return null
  } finally {
    if (mainWindow && restoreTo) {
      showLauncher(restoreTo)
    }
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log('[spaces] screenshot restore show+focus')
      snapshotWindowState('screenshot restore immediate')
      setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
    }
  }
})

let pasteCounter = 0
ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
  try {
    const { writeFileSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null

    const [, mimeType, ext, base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    const filePath = join(tmpdir(), `clui-paste-${timestamp}.${ext}`)
    writeFileSync(filePath, buf)

    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `pasted image ${++pasteCounter}.${ext}`,
      path: filePath,
      mimeType,
      dataUrl,
      size: buf.length,
    }
  } catch {
    return null
  }
})

ipcMain.handle(IPC.EXPORT_CONVERSATION, async (_event, args: { format: 'md' | 'json'; suggestedName: string; content: string }) => {
  try {
    const { join } = require('path')
    const { writeFileSync } = require('fs')
    const { format, suggestedName, content } = args

    const filters = format === 'json'
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [{ name: 'Markdown', extensions: ['md'] }]

    const defaultPath = join(app.getPath('documents'), suggestedName)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export conversation',
      defaultPath,
      filters,
    })

    if (canceled || !filePath) return { ok: false, cancelled: true }
    writeFileSync(filePath, content, 'utf-8')
    return { ok: true, path: filePath }
  } catch (err: any) {
    return { ok: false, error: err.message || 'Export failed.' }
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
  const HARD_TIMEOUT_MS = 45000

  const run = async () => {
    const { writeFileSync, existsSync, unlinkSync, readFileSync } = require('fs')
    const { execFile } = require('child_process')
    const { join, basename } = require('path')
    const { tmpdir } = require('os')

    const startedAt = Date.now()
    const phaseMs: Record<string, number> = {}
    const mark = (name: string, t0: number) => { phaseMs[name] = Date.now() - t0 }

    const tmpWav = join(tmpdir(), `clui-voice-${Date.now()}.wav`)
    try {
      const runExecFile = (bin: string, args: string[], timeout: number): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
            if (err) {
              const detail = stderr?.trim() || stdout?.trim() || err.message
              reject(new Error(detail))
              return
            }
            resolve(stdout || '')
          })
        })

      let t0 = Date.now()
      const buf = Buffer.from(audioBase64, 'base64')
      writeFileSync(tmpWav, buf)
      mark('decode+write_wav', t0)

      // Find whisper backend in priority order: whisperkit-cli (Apple Silicon CoreML) → whisper-cli (whisper-cpp) → whisper (python)
      t0 = Date.now()
      const candidates = [
        '/opt/homebrew/bin/whisperkit-cli',
        '/usr/local/bin/whisperkit-cli',
        '/opt/homebrew/bin/whisper-cli',
        '/usr/local/bin/whisper-cli',
        '/opt/homebrew/bin/whisper',
        '/usr/local/bin/whisper',
        join(homedir(), '.local/bin/whisper'),
      ]

      let whisperBin = ''
      for (const c of candidates) {
        if (existsSync(c)) { whisperBin = c; break }
      }
      mark('probe_binary_paths', t0)

      if (!whisperBin) {
        t0 = Date.now()
        for (const name of ['whisperkit-cli', 'whisper-cli', 'whisper']) {
          try {
            whisperBin = await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
            if (whisperBin) break
          } catch {}
        }
        mark('probe_binary_whence', t0)
      }

      if (!whisperBin) {
        const hint = process.arch === 'arm64'
          ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
          : 'brew install whisper-cpp'
        return {
          error: `Whisper not found. Install with:\n  ${hint}`,
          transcript: null,
        }
      }

      const isWhisperKit = whisperBin.includes('whisperkit-cli')
      const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

      log(`Transcribing with: ${whisperBin} (backend: ${isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper'})`)

      let output: string
      if (isWhisperKit) {
        // WhisperKit (Apple Silicon CoreML) — auto-downloads models on first run
        // Use --report to produce a JSON file with a top-level "text" field for deterministic parsing
        const reportDir = tmpdir()
        t0 = Date.now()
        output = await runExecFile(
          whisperBin,
          ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', reportDir],
          60000
        )
        mark('whisperkit_transcribe_report', t0)

        // WhisperKit writes <audioFileName>.json (filename without extension)
        const wavBasename = basename(tmpWav, '.wav')
        const reportPath = join(reportDir, `${wavBasename}.json`)
        if (existsSync(reportPath)) {
          try {
            t0 = Date.now()
            const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
            const transcript = (report.text || '').trim()
            mark('whisperkit_parse_report_json', t0)
            try { unlinkSync(reportPath) } catch {}
            // Also clean up .srt that --report creates
            const srtPath = join(reportDir, `${wavBasename}.srt`)
            try { unlinkSync(srtPath) } catch {}
            log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
            return { error: null, transcript }
          } catch (parseErr: any) {
            log(`WhisperKit JSON parse failed: ${parseErr.message}, falling back to stdout`)
            try { unlinkSync(reportPath) } catch {}
          }
        }

        // Performance fallback: avoid a second full transcription if report file is missing/invalid.
        // Use stdout from the first run to keep latency close to pre-report behavior.
        if (!output || !output.trim()) {
          t0 = Date.now()
          output = await runExecFile(
            whisperBin,
            ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'],
            60000
          )
          mark('whisperkit_transcribe_stdout_rerun', t0)
        }
      } else if (isWhisperCpp) {
        // whisper-cpp: whisper-cli -m model -f file --no-timestamps
        // Find model file — prefer multilingual (auto-detect language) over .en (English-only)
        const modelCandidates = [
          join(homedir(), '.local/share/whisper/ggml-base.bin'),
          join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
          '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
          '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
          join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
          join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
          '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
          '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
        ]

        let modelPath = ''
        for (const m of modelCandidates) {
          if (existsSync(m)) { modelPath = m; break }
        }

        if (!modelPath) {
          return {
            error: 'Whisper model not found. Download with:\n  mkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
            transcript: null,
          }
        }

        const isEnglishOnly = modelPath.includes('.en.')
        t0 = Date.now()
        output = await runExecFile(
          whisperBin,
          ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-l', isEnglishOnly ? 'en' : 'auto'],
          30000
        )
        mark('whisper_cpp_transcribe', t0)
      } else {
        // Python whisper
        t0 = Date.now()
        output = await runExecFile(
          whisperBin,
          [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpdir()],
          30000
        )
        mark('python_whisper_transcribe', t0)
        // Python whisper writes .txt file
        const txtPath = tmpWav.replace('.wav', '.txt')
        if (existsSync(txtPath)) {
          t0 = Date.now()
          const transcript = readFileSync(txtPath, 'utf-8').trim()
          mark('python_whisper_read_txt', t0)
          try { unlinkSync(txtPath) } catch {}
          log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
          return { error: null, transcript }
        }
        // File not created — Python whisper failed silently
        return {
          error: `Whisper output file not found at ${txtPath}. Check disk space and permissions.`,
          transcript: null,
        }
      }

      // WhisperKit (stdout fallback) and whisper-cpp print to stdout directly
      // Strip timestamp patterns and known hallucination outputs
      const HALLUCINATIONS = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i
      const transcript = output
        .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
        .trim()

      if (HALLUCINATIONS.test(transcript)) {
        log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
        return { error: null, transcript: '' }
      }

      log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
      return { error: null, transcript: transcript || '' }
    } catch (err: any) {
      log(`Transcription error: ${err.message}`)
      log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt, failed: true })}`)
      return {
        error: `Transcription failed: ${err.message}`,
        transcript: null,
      }
    } finally {
      try { unlinkSync(tmpWav) } catch {}
    }
  }

  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<{ error: string | null; transcript: string | null }>((resolve) => {
    timeoutId = setTimeout(() => resolve({
      error: 'Transcription timed out. Try a shorter clip.',
      transcript: null,
    }), HARD_TIMEOUT_MS)
  })

  const result = await Promise.race([run(), timeoutPromise])
  clearTimeout(timeoutId)
  return result
})

ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
  const { readFileSync, existsSync } = require('fs')
  const health = controlPlane.getHealth()

  let recentLogs = ''
  if (existsSync(LOG_FILE)) {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      recentLogs = lines.slice(-100).join('\n')
    } catch {}
  }

  return {
    health,
    logPath: LOG_FILE,
    recentLogs,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    transport: INTERACTIVE_PTY ? 'pty' : 'stream-json',
  }
})

ipcMain.handle(IPC.OPEN_IN_TERMINAL, async (_event, arg: string | null | { sessionId?: string | null; projectPath?: string }) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  // Support both old (string) and new ({ sessionId, projectPath }) calling convention
  let sessionId: string | null = null
  let projectPath: string = process.cwd()
  if (typeof arg === 'string') {
    sessionId = arg
  } else if (arg && typeof arg === 'object') {
    sessionId = arg.sessionId ?? null
    projectPath = arg.projectPath && arg.projectPath !== '~' ? arg.projectPath : process.cwd()
  }

  // Validate sessionId — must be a strict UUID to prevent injection
  if (sessionId && !UUID_RE.test(sessionId)) {
    log(`OPEN_IN_TERMINAL: rejected invalid sessionId: ${sessionId}`)
    return false
  }

  if (!isSafeAbsolutePath(projectPath)) {
    log(`OPEN_IN_TERMINAL: rejected invalid projectPath: ${projectPath}`)
    return false
  }

  const { command, args } = cliInvocation(sessionId ? ['--resume', sessionId] : [])
  const result = await openInPlatformTerminal(projectPath, [command, ...args])
  if (!result.ok) log(`Failed to open terminal: ${result.error}`)
  return result.ok
})

// ─── Marketplace IPC ───

ipcMain.handle(IPC.MARKETPLACE_FETCH, async (_event, { forceRefresh } = {}) => {
  log('IPC MARKETPLACE_FETCH')
  return fetchCatalog(forceRefresh)
})

ipcMain.handle(IPC.MARKETPLACE_INSTALLED, async () => {
  log('IPC MARKETPLACE_INSTALLED')
  return listInstalled()
})

ipcMain.handle(IPC.MARKETPLACE_INSTALL, async (_event, { repo, pluginName, marketplace, sourcePath, isSkillMd }: { repo: string; pluginName: string; marketplace: string; sourcePath?: string; isSkillMd?: boolean }) => {
  log(`IPC MARKETPLACE_INSTALL: ${pluginName} from ${repo} (isSkillMd=${isSkillMd})`)
  return installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd)
})

ipcMain.handle(IPC.MARKETPLACE_UNINSTALL, async (_event, { pluginName }: { pluginName: string }) => {
  log(`IPC MARKETPLACE_UNINSTALL: ${pluginName}`)
  return uninstallPlugin(pluginName)
})

// ─── OpenClaw Controls ───

ipcMain.handle(IPC.OPENCLAW_HEALTH, async () => {
  const res = await runCliAsync(['health'], 8000)
  return res.ok
    ? { ok: true, output: res.stdout, error: null }
    : { ok: false, output: res.stdout, error: res.stderr || 'Health check failed' }
})

ipcMain.handle(IPC.OPENCLAW_ONBOARD, async () => {
  const { command, args } = cliInvocation(['onboard'])
  return openInPlatformTerminal(homedir(), [command, ...args])
})

ipcMain.handle(IPC.OPENCLAW_MODEL_INFO, async () => {
  // Remote mode: the agent runs on the gateway, so its model list is the one
  // that matters. Local config generally has no models section at all here.
  if (isRemoteGatewayMode()) {
    const remote = await fetchGatewayModelInfo()
    if (remote) return remote
    log('Gateway model info unavailable — falling back to local config')
    if (!resolveGatewayToken()) {
      const id = (() => {
        try { return readOpenclawConfig().gateway?.remote?.token?.id || 'OPENCLAW_REMOTE_TOKEN' } catch { return 'OPENCLAW_REMOTE_TOKEN' }
      })()
      return {
        ok: false,
        provider: null,
        model: null,
        providers: [],
        error: `Gateway credential not readable by this app. Set ${id} for your user account, then restart OpenClaw UI.`,
      }
    }
  }

  try {
    const config = readOpenclawConfig()
    const providersMap = config.models?.providers || {}
    const providers = Object.entries(providersMap).map(([id, info]) => ({
      id,
      models: (info.models || [])
        .map((m) => ({ id: String(m.id || '').trim(), name: String(m.name || m.id || '').trim() }))
        .filter((m) => m.id),
    }))

    const primary = config.agents?.defaults?.model?.primary || ''
    let provider: string | null = null
    let model: string | null = null
    if (primary.includes('/')) {
      const parts = primary.split('/')
      provider = parts[0] || null
      model = parts.slice(1).join('/') || null
    }

    return { ok: true, provider, model, providers }
  } catch (err: any) {
    return { ok: false, provider: null, model: null, providers: [], error: err?.message || 'Failed to load model info' }
  }
})

ipcMain.handle(IPC.OPENCLAW_SET_MODEL, async (_event, { provider, model }: { provider: string; model: string }) => {
  if (!provider || !model) return { ok: false, error: 'provider and model are required' }

  // Remote mode: write to the gateway, since that is where the agent resolves
  // its model. Writing local config here would silently change nothing.
  if (isRemoteGatewayMode()) {
    return setGatewayModel(provider, model)
  }

  try {
    const config = readOpenclawConfig()
    const providerNode = config.models?.providers?.[provider]
    if (!providerNode) return { ok: false, error: `Unknown provider: ${provider}` }
    const hasModel = (providerNode.models || []).some((m) => (m.id || '') === model)
    if (!hasModel) return { ok: false, error: `Unknown model for provider ${provider}: ${model}` }

    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    if (!config.agents.defaults.model) config.agents.defaults.model = {}

    config.agents.defaults.model.primary = `${provider}/${model}`
    const fallbacks = config.agents.defaults.model.fallbacks || []
    config.agents.defaults.model.fallbacks = fallbacks.filter((f) => String(f).startsWith(`${provider}/`))

    writeOpenclawConfig(config)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to update model' }
  }
})

/** A command attempt: CLI subcommand args, or an unrelated external binary. */
type RunCandidate = { args: string[]; bin?: string }

ipcMain.handle(IPC.OPENCLAW_RUN, async (_event, { action }: { action: string }) => {
  const commandMap: Record<string, RunCandidate[]> = {
    gateway_start: [{ args: ['gateway', 'start'] }],
    gateway_stop: [{ args: ['gateway', 'stop'] }],
    gateway_restart: [{ args: ['gateway', 'restart'] }],
    gateway_install: [{ args: ['gateway', 'install'] }],
    channels_status: [{ args: ['channels', 'status'] }],
    plugins_list: [{ args: ['plugins', 'list'] }],
    skills_list: [{ args: ['skills', 'list'] }],
    update_check: [
      { args: ['update', 'check'] },
      { args: ['update', 'status'] },
      { args: ['update'] },
    ],
    update_upgrade: [
      { args: ['update', 'upgrade'] },
      { args: ['update', 'install'] },
      { args: ['update'] },
    ],
    gateway_link_whatsapp_qr: [
      { args: ['channels', 'whatsapp', 'link'] },
      { args: ['channels', 'whatsapp', 'qr'] },
      { args: ['channels', 'link', 'whatsapp'] },
    ],
  }
  let candidates = commandMap[action]
  if (!candidates && action.startsWith('clawhub_install:')) {
    const slug = action.slice('clawhub_install:'.length).trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
      return { ok: false, output: '', error: `Invalid skill slug: ${slug}` }
    }
    candidates = [
      { bin: 'clawhub', args: ['install', slug] },
      { args: ['clawhub', 'install', slug] },
    ]
  }
  if (!candidates && action.startsWith('clawhub_inspect:')) {
    const slug = action.slice('clawhub_inspect:'.length).trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
      return { ok: false, output: '', error: `Invalid skill slug: ${slug}` }
    }
    candidates = [{ bin: 'clawhub', args: ['inspect', slug] }]
  }
  if (!candidates && action.startsWith('clawhub_search:')) {
    const query = action.slice('clawhub_search:'.length).trim()
    if (!query) {
      return { ok: false, output: '', error: 'Search query is required' }
    }
    candidates = [{ bin: 'clawhub', args: ['search', query, '--limit', '8'] }]
  }
  if (!candidates || candidates.length === 0) return { ok: false, output: '', error: `Unsupported action: ${action}` }

  let lastError = 'Command failed'
  let lastStdout = ''
  const tried: string[] = []

  for (const candidate of candidates) {
    tried.push([candidate.bin || getCliRuntime().kind, ...candidate.args].join(' '))

    // External binaries run as-is; CLI subcommands go through the resolved
    // runtime so they work on Windows, where the CLI is a Node script. Both
    // run async — these are button-triggered and would otherwise freeze the UI.
    const res = candidate.bin
      ? await runBinAsync(candidate.bin, candidate.args, 15000)
      : await runCliAsync(candidate.args, 15000)

    if (res.ok) {
      if (
        (action.startsWith('clawhub_search:') || action.startsWith('clawhub_inspect:'))
        && res.stdout.length === 0
      ) {
        lastError = 'ClawHub returned no output'
        continue
      }
      return { ok: true, output: redactSecrets(res.stdout) }
    }

    lastError = res.stderr || 'Command failed'
    lastStdout = res.stdout
  }

  return { ok: false, output: redactSecrets(lastStdout), error: `${redactSecrets(lastError)}\nTried:\n${tried.join('\n')}`.trim() }
})

// ─── Gateway RPC ───

/** True when the CLI is configured to route runs at a remote gateway. */
function isRemoteGatewayMode(): boolean {
  try {
    return readOpenclawConfig().gateway?.mode === 'remote'
  } catch {
    return false
  }
}

/**
 * Resolve the gateway credential from the environment.
 *
 * `openclaw tui` can resolve `gateway.remote.token` as a secret reference, but
 * `openclaw gateway call` cannot — it fails with
 * GatewaySecretRefUnavailableError and expects the value in the environment
 * instead. So every RPC has to carry the credential explicitly.
 */
/**
 * Read a persistent user-scoped environment variable on Windows.
 *
 * A process only inherits the environment of whatever launched it, so an app
 * started from a shell that predates the variable never sees it — the same
 * app launched from Explorer does. Reading HKCU\Environment directly makes
 * credential resolution independent of how the app happened to be started.
 */
const winUserEnvCache = new Map<string, string | null>()
function readWindowsUserEnv(name: string): string | null {
  if (process.platform !== 'win32') return null
  if (winUserEnvCache.has(name)) return winUserEnvCache.get(name) ?? null

  let value: string | null = null
  try {
    const { execFileSync } = require('child_process')
    const out = String(
      execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
    const match = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/i)
    if (match) value = match[1].trim() || null
  } catch {
    // Not set, or reg.exe unavailable.
  }

  winUserEnvCache.set(name, value)
  return value
}

function resolveGatewayToken(): string | null {
  let configuredId: string | null = null
  try {
    configuredId = readOpenclawConfig().gateway?.remote?.token?.id || null
  } catch {
    // Missing/unparseable config — fall through to the conventional names.
  }

  const names = [configuredId, 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_REMOTE_TOKEN'].filter(Boolean) as string[]

  for (const name of names) {
    if (process.env[name]) return process.env[name] as string
  }
  // Nothing in our own environment — consult the persistent user environment.
  for (const name of names) {
    const fromRegistry = readWindowsUserEnv(name)
    if (fromRegistry) {
      log(`Resolved gateway credential from the persistent user environment (${name})`)
      return fromRegistry
    }
  }
  return null
}

/**
 * Call a gateway RPC method and parse its JSON reply.
 *
 * Params go through a single argv element, so no shell quoting is involved,
 * and the credential travels in the child's environment rather than on its
 * command line where other local processes could read it.
 */
async function gatewayCallJson(method: string, params: unknown = {}, timeoutMs = 25000): Promise<any | null> {
  const token = resolveGatewayToken()
  if (!token) {
    log(`gateway call ${method} skipped — no gateway credential resolvable in this process`)
    return null
  }

  const res = await runCliAsync(
    ['gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    timeoutMs,
    { OPENCLAW_GATEWAY_TOKEN: token },
  )
  if (!res.stdout) {
    log(`gateway call ${method} produced no output: ${res.stderr.slice(0, 200)}`)
    return null
  }
  try {
    const parsed = JSON.parse(res.stdout)
    if (parsed && parsed.ok === false) {
      log(`gateway call ${method} rejected: ${parsed.error?.message || 'unknown error'}`)
      return null
    }
    return parsed
  } catch {
    log(`gateway call ${method} returned unparseable output`)
    return null
  }
}

/**
 * Model options as the gateway sees them.
 *
 * In remote mode the models that matter live on the gateway, not here — a
 * local openclaw.json pointed at a remote gateway usually has no models
 * section at all, which left the picker empty and unable to correct a broken
 * server-side model. Unavailable models are filtered out: offering a model the
 * gateway has no credential for only produces a failed run.
 */
type GatewayModelInfo = {
  ok: boolean
  provider: string | null
  model: string | null
  providers: Array<{ id: string; models: Array<{ id: string; name: string }> }>
}

// Each gateway RPC costs ~9s (CLI process startup plus a network round trip),
// so an uncached picker leaves its dropdowns empty long enough to look broken.
// Cache the result and collapse concurrent callers onto one fetch.
const GATEWAY_MODEL_TTL_MS = 60_000
let gatewayModelCache: { at: number; value: GatewayModelInfo } | null = null
let gatewayModelInflight: Promise<GatewayModelInfo | null> | null = null

function invalidateGatewayModelCache(): void {
  gatewayModelCache = null
}

async function fetchGatewayModelInfo(force = false): Promise<GatewayModelInfo | null> {
  if (!force && gatewayModelCache && Date.now() - gatewayModelCache.at < GATEWAY_MODEL_TTL_MS) {
    return gatewayModelCache.value
  }
  // A second caller arriving mid-fetch waits on the same promise rather than
  // starting another 9s round trip.
  if (gatewayModelInflight) return gatewayModelInflight

  gatewayModelInflight = _fetchGatewayModelInfoUncached()
  try {
    const value = await gatewayModelInflight
    if (value) gatewayModelCache = { at: Date.now(), value }
    return value
  } finally {
    gatewayModelInflight = null
  }
}

async function _fetchGatewayModelInfoUncached(): Promise<GatewayModelInfo | null> {
  const [modelsRes, agentsRes] = await Promise.all([
    gatewayCallJson('models.list'),
    gatewayCallJson('agents.list'),
  ])
  if (!modelsRes?.models) return null

  const byProvider = new Map<string, Array<{ id: string; name: string }>>()
  for (const m of modelsRes.models as Array<Record<string, any>>) {
    if (m.available !== true) continue
    const provider = String(m.provider || '').trim()
    const id = String(m.id || '').trim()
    if (!provider || !id) continue
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider)!.push({ id, name: String(m.name || id) })
  }

  // Current selection comes from the default agent's primary model.
  let provider: string | null = null
  let model: string | null = null
  const defaultId = agentsRes?.defaultId || 'main'
  const agent = (agentsRes?.agents || []).find((a: any) => a?.id === defaultId) || agentsRes?.agents?.[0]
  const primary = String(agent?.model?.primary || '')
  if (primary.includes('/')) {
    const idx = primary.indexOf('/')
    provider = primary.slice(0, idx) || null
    model = primary.slice(idx + 1) || null
    // A wildcard is a valid key in the per-model settings map but not a
    // concrete model id — treat it as "nothing selected" rather than showing
    // a selection that cannot resolve.
    if (model === '*' || model === '') model = null
  }

  return {
    ok: true,
    provider,
    model,
    providers: Array.from(byProvider.entries())
      .map(([id, models]) => ({ id, models: models.sort((a, b) => a.id.localeCompare(b.id)) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * Point the gateway's default agent at a model.
 *
 * `agents.list` is an array, and config.patch replaces arrays wholesale, so
 * this is a read-modify-write of the whole list rather than a targeted set.
 */
async function setGatewayModel(provider: string, model: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await gatewayCallJson('config.get', {})
  const parsed = cfg?.parsed
  if (!parsed) return { ok: false, error: 'Could not read gateway configuration' }

  const target = `${provider}/${model}`
  const agents = parsed.agents || {}
  const list: any[] = Array.isArray(agents.list) ? agents.list : []
  const defaultId = agents.defaults?.id || 'main'

  const nextList = list.map((entry) => {
    if (entry?.id !== defaultId && list.length > 1) return entry
    const existing = entry?.model || {}
    // Fallbacks without a provider prefix resolve against the wrong provider
    // and can never succeed — drop them rather than preserve a broken entry.
    const fallbacks = (Array.isArray(existing.fallbacks) ? existing.fallbacks : [])
      .map((f: unknown) => String(f))
      .filter((f: string) => f.includes('/') && f !== target)
    return { ...entry, model: { ...existing, primary: target, ...(fallbacks.length ? { fallbacks } : {}) } }
  })

  if (nextList.length === 0) {
    nextList.push({ id: defaultId, model: { primary: target } })
  }

  const patch = {
    agents: {
      defaults: { model: { primary: target } },
      list: nextList,
    },
  }

  const res = await gatewayCallJson('config.patch', { raw: JSON.stringify(patch) }, 30000)
  if (!res) return { ok: false, error: 'Gateway rejected the configuration patch' }
  // The cached view now describes the old selection.
  invalidateGatewayModelCache()
  log(`Gateway default model set to ${target}`)
  return { ok: true }
}

// ─── Node Host + Gateway Management ───

/** Read this machine's node identity, written by `openclaw node install`. */
function readNodeIdentity(): { nodeId: string | null; displayName: string | null; host: string | null; port: number | null; tls: boolean } {
  const empty = { nodeId: null, displayName: null, host: null, port: null, tls: false }
  try {
    const raw = readFileSync(join(homedir(), '.openclaw', 'node.json'), 'utf-8')
    const parsed = JSON.parse(raw) as {
      nodeId?: string
      displayName?: string
      gateway?: { host?: string; port?: number; tls?: boolean }
    }
    return {
      nodeId: parsed.nodeId || null,
      displayName: parsed.displayName || null,
      host: parsed.gateway?.host || null,
      port: typeof parsed.gateway?.port === 'number' ? parsed.gateway.port : null,
      tls: !!parsed.gateway?.tls,
    }
  } catch {
    return empty
  }
}

ipcMain.handle(IPC.NODE_STATUS, async (): Promise<NodeHostStatus> => {
  const identity = readNodeIdentity()
  const res = await runCliAsync(['node', 'status'], 20000)
  const text = `${res.stdout}\n${res.stderr}`

  const pidMatch = text.match(/pid\s+(\d+)/i)
  const serviceMatch = text.match(/Service:\s*([^\n(]+)/i)

  return {
    installed: /registered|installed/i.test(text) && !/not installed|missing/i.test(text),
    running: /Runtime:\s*running/i.test(text),
    pid: pidMatch ? Number(pidMatch[1]) : null,
    displayName: identity.displayName,
    nodeId: identity.nodeId,
    gatewayHost: identity.host,
    gatewayPort: identity.port,
    tls: identity.tls,
    serviceKind: serviceMatch ? serviceMatch[1].trim() : null,
    // Must be redacted: `node status` echoes the service environment block,
    // which carries the gateway token in plaintext.
    raw: redactSecrets(text.trim()),
  }
})

ipcMain.handle(IPC.NODE_ACTION, async (_event, { action }: { action: NodeAction }) => {
  const allowed: NodeAction[] = ['install', 'start', 'stop', 'restart', 'uninstall']
  if (!allowed.includes(action)) {
    return { ok: false, output: '', error: `Unsupported node action: ${action}` }
  }
  log(`IPC NODE_ACTION: ${action}`)
  // Service registration can take a while and may prompt for elevation, so
  // this must never run synchronously on the main thread.
  const res = await runCliAsync(['node', action], 60000)
  return res.ok
    ? { ok: true, output: redactSecrets(res.stdout) }
    : { ok: false, output: redactSecrets(res.stdout), error: redactSecrets(res.stderr) || `node ${action} failed` }
})

ipcMain.handle(IPC.GATEWAY_STATUS, async () => {
  const token = resolveGatewayToken()
  const res = await runCliAsync(['gateway', 'status'], 30000, token ? { OPENCLAW_GATEWAY_TOKEN: token } : {})
  const text = `${res.stdout}\n${res.stderr}`.trim()
  return {
    ok: res.ok,
    running: /Runtime:\s*running/i.test(text),
    installed: !/Service unit not found|Service not installed/i.test(text),
    output: redactSecrets(text),
  }
})

ipcMain.handle(IPC.GATEWAY_PROBE, async () => {
  const token = resolveGatewayToken()
  const res = await runCliAsync(['gateway', 'probe'], 45000, token ? { OPENCLAW_GATEWAY_TOKEN: token } : {})
  const text = `${res.stdout}\n${res.stderr}`.trim()
  const capability = text.match(/Capability:\s*([^\n·]+)/i)?.[1]?.trim() || null
  return {
    ok: res.ok,
    reachable: /Reachable:\s*yes/i.test(text),
    capability,
    // The gateway rejects operator calls until the credential carries
    // operator scope; surface that explicitly rather than as a generic failure.
    missingOperatorScope: /missing scope:\s*operator/i.test(text),
    output: redactSecrets(text),
  }
})

ipcMain.handle(IPC.GATEWAY_CONFIG_GET, async (): Promise<GatewayConfigView> => {
  let config: OpenclawConfig = {}
  try {
    config = readOpenclawConfig()
  } catch {
    // Missing or unparseable config — report empty rather than throwing.
  }
  const remote = config.gateway?.remote
  const tokenId = remote?.token?.id || null
  return {
    mode: config.gateway?.mode || null,
    remoteUrl: remote?.url || null,
    tokenRef: tokenId ? { source: remote?.token?.source || 'env', id: tokenId } : null,
    // Report only whether the credential resolves — never the value itself.
    tokenResolvable: !!(tokenId && process.env[tokenId]),
    configPath: openclawConfigPath(),
  }
})

ipcMain.handle(
  IPC.GATEWAY_CONFIG_SET,
  async (_event, patch: { mode?: 'local' | 'remote'; remoteUrl?: string; tokenEnvVar?: string }) => {
    try {
      let config: OpenclawConfig
      try {
        config = readOpenclawConfig()
      } catch {
        config = {}
      }

      if (!config.gateway) config.gateway = {}

      if (patch.mode) config.gateway.mode = patch.mode

      if (patch.remoteUrl !== undefined) {
        const url = patch.remoteUrl.trim()
        if (url) {
          // Refuse plaintext WebSocket to a non-loopback host: the credential
          // would cross the public internet unencrypted.
          const parsed = (() => {
            try { return new URL(url) } catch { return null }
          })()
          if (!parsed) return { ok: false, error: `Not a valid URL: ${url}` }
          const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
          if (parsed.protocol === 'ws:' && !isLoopback) {
            return { ok: false, error: 'Refusing an insecure ws:// URL for a remote host — use wss://' }
          }
          if (!['ws:', 'wss:'].includes(parsed.protocol)) {
            return { ok: false, error: `Gateway URL must be ws:// or wss:// (got ${parsed.protocol})` }
          }
          if (!config.gateway.remote) config.gateway.remote = {}
          config.gateway.remote.url = url
          config.gateway.remote.enabled = true
        }
      }

      if (patch.tokenEnvVar) {
        if (!/^[A-Z][A-Z0-9_]*$/i.test(patch.tokenEnvVar)) {
          return { ok: false, error: `Not a valid environment variable name: ${patch.tokenEnvVar}` }
        }
        if (!config.gateway.remote) config.gateway.remote = {}
        config.gateway.remote.token = { source: 'env', provider: 'default', id: patch.tokenEnvVar }
      }

      writeOpenclawConfig(config)
      log(`Gateway config updated: mode=${config.gateway.mode} url=${config.gateway.remote?.url || '(unset)'}`)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update gateway config' }
    }
  },
)

ipcMain.handle(IPC.GET_CONNECTION_TARGET, async () => controlPlane.getConnectionTarget())

ipcMain.handle(IPC.SET_CONNECTION_TARGET, async (_event, target: ConnectionTarget) => {
  const modes: ConnectionTarget['mode'][] = ['auto', 'local', 'gateway']
  if (!target || !modes.includes(target.mode)) {
    return { ok: false, error: `Unsupported connection mode: ${target?.mode}` }
  }

  if (target.mode === 'gateway') {
    if (!target.url) return { ok: false, error: 'A gateway URL is required' }

    let config: OpenclawConfig = {}
    try {
      config = readOpenclawConfig()
    } catch {
      config = {}
    }
    const tokenEnvVar = config.gateway?.remote?.token?.id || null
    const envToken = (tokenEnvVar && process.env[tokenEnvVar]) || undefined

    // Preferred path: openclaw.json already names this gateway and its
    // credential resolves, so the run needs no flags and the token stays out
    // of the process table. `gateway.mode` must be 'remote' — it is the only
    // key the CLI consults when deciding to route remotely.
    const configTargetsThisGateway =
      config.gateway?.mode === 'remote'
      && config.gateway?.remote?.url === target.url
      && !!envToken

    if (configTargetsThisGateway) {
      controlPlane.setConnectionTarget({ mode: 'gateway', url: target.url, viaConfig: true })
      return { ok: true }
    }

    // Fallback: pass the credential explicitly. The CLI rejects --url without
    // one, so this is the only way to reach a gateway that config does not
    // already describe — at the cost of argv exposure.
    const token = target.token || envToken
    if (!token && !target.password) {
      return {
        ok: false,
        error: 'No gateway credential available — set the token environment variable referenced by gateway.remote.token',
      }
    }
    log('Connection target set with an explicit credential — config does not describe this gateway')
    controlPlane.setConnectionTarget({ ...target, token })
    return { ok: true }
  }

  controlPlane.setConnectionTarget({ mode: target.mode })
  return { ok: true }
})

// Diagnostic only: renderer-reported shell geometry across a summon.
// The renderer has painted its prepare pass — safe to make the window visible.
ipcMain.on(IPC.WINDOW_READY, (_e, generation: number) => {
  if (pendingReveal && pendingReveal.generation === generation) {
    pendingReveal.reveal('renderer ack')
  }
})

// The renderer has finished its exit animation — safe to move the window away.
ipcMain.on(IPC.WINDOW_DISMISS_READY, (_e, generation: number) => {
  parkLauncher(generation, 'renderer ack')
})

ipcMain.on(IPC.TRACE_SHELL, (_e, line: string) => {
  if (SPACES_DEBUG) log(`[shell] ${String(line).slice(0, 400)}`)
})

ipcMain.handle(IPC.GET_SHORTCUTS, async () => ({
  platform: process.platform,
  shortcuts: getShortcuts(process.platform),
}))

// ─── Theming + branding ───

ipcMain.handle(IPC.THEME_EXPORT, async (_event, { theme, suggestedName }: { theme: unknown; suggestedName: string }) => {
  const check = validateTheme(theme)
  if (!check.ok) return { ok: false, error: `Refusing to export an invalid theme: ${check.error}` }

  const safeName = (suggestedName || 'theme').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'theme'
  const result = await dialog.showSaveDialog({
    title: 'Export theme',
    defaultPath: join(app.getPath('downloads'), `${safeName}.openclaw-theme.json`),
    filters: [{ name: 'OpenClaw Theme', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true }

  try {
    const payload: ThemeFile = { kind: THEME_FILE_KIND, version: THEME_FILE_VERSION, theme: check.theme }
    writeFileSync(result.filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
    log(`Theme exported to ${result.filePath}`)
    return { ok: true, path: result.filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to write theme file' }
  }
})

ipcMain.handle(IPC.THEME_IMPORT, async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import theme',
    properties: ['openFile'],
    filters: [{ name: 'OpenClaw Theme', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true }

  try {
    const raw = readFileSync(result.filePaths[0], 'utf-8')
    // A theme file is arbitrary user-supplied JSON — validate before it can
    // reach the renderer and become live CSS.
    const check = validateTheme(JSON.parse(raw))
    if (!check.ok) return { ok: false, error: `Not a valid theme file: ${check.error}` }
    log(`Theme imported from ${result.filePaths[0]}`)
    return { ok: true, theme: check.theme }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to read theme file' }
  }
})

/**
 * Branding is presentation only. It renames what the user sees — window title,
 * tray tooltip and menu — and never touches IPC channels, CLI arguments or
 * the ~/.openclaw paths the CLI actually depends on.
 */
ipcMain.on(IPC.SET_BRANDING, (_event, branding: { appName?: string; tagline?: string }) => {
  const name = (branding?.appName || '').trim().slice(0, 64)
  if (!name) return
  try {
    mainWindow?.setTitle(name)
    if (tray) {
      tray.setToolTip(branding?.tagline ? `${name} — ${branding.tagline}`.slice(0, 127) : name)
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: `Show ${name}`, click: () => showWindow('tray menu') },
          { label: 'Quit', click: () => { app.quit() } },
        ]),
      )
    }
  } catch (err: any) {
    log(`Failed to apply branding: ${err?.message}`)
  }
})

ipcMain.handle(IPC.GET_RUNTIME_METRICS, async () => {
  const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024))
  const uptimeSec = Math.round(process.uptime())
  return {
    cpuPercent: sampleCpuPercent(),
    memoryMb,
    uptimeSec,
    timestamp: Date.now(),
  }
})

// ─── Theme Detection ───

ipcMain.handle(IPC.GET_THEME, () => {
  return { isDark: nativeTheme.shouldUseDarkColors }
})

nativeTheme.on('updated', () => {
  broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
})

// ─── Permission Preflight ───
// Request all required macOS permissions upfront on first launch so the user
// is never interrupted mid-session by a permission prompt.

async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  // ── Microphone (for voice input via Whisper) ──
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err: any) {
    log(`Permission preflight: microphone check failed — ${err.message}`)
  }

  // ── Accessibility (for global ⌥+Space shortcut) ──
  // globalShortcut works without it on modern macOS; Cmd+Shift+K is always the fallback.
  // Screen Recording: not requested upfront — macOS 15 Sequoia shows an alarming
  // "bypass private window picker" dialog. Let the OS prompt naturally if/when
  // the screenshot feature is actually used.
}

// ─── Global Shortcuts ───

/**
 * Register every global shortcut from the shared table.
 *
 * Registration can fail when another application already owns an accelerator —
 * notably Alt+Space, which Windows uses for the window system menu and some
 * macOS input sources claim for switching layouts. A failure is reported, not
 * fatal: the Ctrl/Cmd+Shift+K fallback covers the launcher either way.
 */
function registerGlobalShortcuts(): void {
  const handlers: Record<ShortcutId, () => void> = {
    'toggle-launcher': () => debouncedToggle('shortcut toggle-launcher'),
    'toggle-launcher-fallback': () => debouncedToggle('shortcut toggle-launcher-fallback'),
    'toggle-marketplace': () => {
      showWindow('shortcut toggle-marketplace')
      broadcast('clui:shortcut-action', 'toggle-marketplace')
    },
    'open-agents': () => {
      showWindow('shortcut open-agents')
      broadcast('clui:shortcut-action', 'open-agents')
    },
    'open-settings': () => {
      showWindow('shortcut open-settings')
      broadcast('clui:shortcut-action', 'open-settings')
    },
  }

  for (const def of getShortcuts(process.platform)) {
    try {
      const ok = globalShortcut.register(def.accelerator, handlers[def.id])
      if (!ok) {
        log(`Shortcut ${def.accelerator} (${def.id}) rejected — another app likely owns it`)
      }
    } catch (err: any) {
      log(`Shortcut ${def.accelerator} (${def.id}) failed to register: ${err?.message}`)
    }
  }
}

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  // A losing second instance is already quitting — do not create a window or
  // register accelerators, or it would double every shortcut before exiting.
  if (!hasSingleInstanceLock) return

  // macOS: become an accessory app. Accessory apps can have key windows (keyboard works)
  // without deactivating the currently active app (hover preserved in browsers).
  // This is how Spotlight, Alfred, Raycast work.
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'))
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
    app.dock.hide()
  }

  // Request permissions upfront so the user is never interrupted mid-session.
  await requestPermissions()

  // Skill provisioning — non-blocking, streams status to renderer
  ensureSkills((status: SkillStatus) => {
    log(`Skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    broadcast(IPC.SKILL_STATUS, status)
  }).catch((err: Error) => log(`Skill provisioning error: ${err.message}`))

  // Warm the gateway model cache in the background. Each RPC is ~9s, so
  // fetching it lazily means the first visit to Settings stares at empty
  // dropdowns; doing it now means the data is usually already there.
  if (isRemoteGatewayMode()) {
    fetchGatewayModelInfo()
      .then((info) => log(info ? `Gateway model cache warmed (${info.providers.length} providers)` : 'Gateway model cache warm failed'))
      .catch(() => log('Gateway model cache warm threw'))
  }

  createWindow()
  snapshotWindowState('after createWindow')

  if (SPACES_DEBUG) {
    mainWindow?.on('show', () => snapshotWindowState('event window show'))
    mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

    app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
    app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

    screen.on('display-added', (_e, display) => {
      log(`[spaces] event display-added id=${display.id}`)
      snapshotWindowState('event display-added')
    })
    screen.on('display-removed', (_e, display) => {
      log(`[spaces] event display-removed id=${display.id}`)
      snapshotWindowState('event display-removed')
    })
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
      snapshotWindowState('event display-metrics-changed')
    })
  }


  // Accelerators are platform-neutral: CommandOrControl resolves to Cmd on
  // macOS and Ctrl elsewhere, and Alt is Option on macOS.
  registerGlobalShortcuts()

  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 })
  trayIcon.setTemplateImage(false)
  tray = new Tray(trayIcon)
  tray.setToolTip('OpenClaw UI')
  // On Windows a left-click fires 'click' while a context menu is also
  // attached, so a single interaction could both toggle the window and open
  // the menu — then choosing "Show" summoned it a second time. Route the
  // click through the same debounce the accelerators use so one interaction
  // can only ever produce one toggle.
  tray.on('click', () => trayToggle())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show OpenClaw UI', click: () => showWindow('tray menu') },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  )

  // app 'activate' fires when macOS brings the app to the foreground (e.g. after
  // webContents.focus() triggers applicationDidBecomeActive on some macOS versions).
  // Using showWindow here instead of toggleWindow prevents the re-entry race where
  // a summon immediately hides itself because activate fires mid-show.
  app.on('activate', () => showWindow('app activate'))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  controlPlane.shutdown()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
