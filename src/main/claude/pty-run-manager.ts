/**
 * PtyRunManager: Interactive PTY transport for Claude Code.
 *
 * Spawns `claude` (without -p) via node-pty to get the full interactive
 * terminal experience, including permission prompts. Parses the PTY output
 * to extract text, tool calls, and permission requests, then emits
 * normalized events identical to RunManager.
 *
 * This module is behind the `CLUI_INTERACTIVE_PERMISSIONS_PTY` feature flag.
 *
 * Known limitations:
 * - Parsing depends on Claude CLI's terminal output format (Ink-based)
 * - ANSI stripping may lose some formatting nuance
 * - Permission prompt detection uses heuristics, not a formal grammar
 * - If the CLI's UI changes significantly, the parser may break
 */

import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join, delimiter } from 'path'
import { appendFileSync, chmodSync, existsSync, statSync } from 'fs'
import type { RunOptions, EnrichedError } from '../../shared/types'
import { getCliEnv } from '../cli-env'
import { getCliRuntime, type CliRuntime } from '../openclaw/runtime'

// node-pty is a native module — require at runtime to avoid Vite bundling issues
let pty: typeof import('node-pty')
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  // Will be set when first needed — fail at startRun() time, not import time
}

const LOG_FILE = join(homedir(), '.clui-debug.log')
const MAX_RING_LINES = 100
const PTY_BUFFER_SIZE = 50 // rolling window of cleaned lines for parser context
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const QUIESCENCE_MS = 2000

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [PtyRunManager] ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
}

// ─── ANSI Stripping ───

/**
 * Strip ANSI escape sequences (colors, cursor movement, clear line, etc.)
 */
export function stripAnsi(str: string): string {
  // Covers CSI sequences including private modes like ?2004h
  return str.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC sequences
    .replace(/\x1b[()][0-9A-Za-z]/g, '')  // character set selection
    .replace(/\x1b[#=>\[\]]/g, '')         // misc escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars except \n \r \t
}

export function normalizeForMatch(input: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let lastSpace = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const lower = ch.toLowerCase()
    if (/[a-z0-9]/.test(lower)) {
      norm += lower
      map.push(i)
      lastSpace = false
      continue
    }
    if (/\s/.test(lower) || /[^a-z0-9]/.test(lower)) {
      if (!lastSpace && norm.length > 0) {
        norm += ' '
        map.push(i)
        lastSpace = true
      }
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1)
    map.pop()
  }
  return { norm, map }
}

// ─── Permission Prompt Detection ───

interface ParsedPermission {
  toolName: string
  rawPrompt: string
  options: Array<{ optionId: string; label: string; terminalValue: string }>
}

/**
 * Confidence-scored permission prompt detector.
 * Looks at a window of cleaned terminal lines and tries to identify
 * a Claude permission prompt.
 */
export function detectPermissionPrompt(lines: string[]): ParsedPermission | null {
  const joined = lines.join('\n')

  // ─── Pattern 1: "Claude wants to use <ToolName>" or "Allow <ToolName>" ───
  // The interactive CLI typically shows something like:
  //   "Claude wants to use Bash"
  //   "Command: ls -la"
  //   "❯ Allow for this project  Allow once  Deny"

  let confidence = 0
  let toolName = ''
  let rawPrompt = ''

  // Check for tool permission keywords
  const toolMatch = joined.match(/(?:wants?\s+to\s+(?:use|run|execute)|Tool:\s*|tool_name:\s*)(\w+)/i)
  if (toolMatch) {
    toolName = toolMatch[1]
    confidence += 3
  }

  // Check for permission-specific keywords
  const permissionKeywords = [
    /\ballow\b/i,
    /\bdeny\b/i,
    /\breject\b/i,
    /\bpermission\b/i,
    /\bapprove\b/i,
  ]
  for (const kw of permissionKeywords) {
    if (kw.test(joined)) confidence++
  }

  // Check for option-like patterns (numbered or arrow-selected)
  const hasOptions = /(?:❯|›|>)\s*(?:Allow|Deny|Yes|No)/i.test(joined)
    || /\b(?:Allow\s+(?:once|always|for\s+(?:this\s+)?(?:project|session)))\b/i.test(joined)
  if (hasOptions) confidence += 2

  // Need at least 4 confidence to declare a permission prompt
  if (confidence < 4) return null

  // ─── Extract options ───
  const options: ParsedPermission['options'] = []

  // Try to find option labels. The interactive CLI typically shows:
  // ❯ Allow for this project  |  Allow once  |  Deny
  // Or vertically:
  // ❯ Allow for this project
  //   Allow once
  //   Deny

  // Pattern: Look for Allow/Deny variants
  const optionPatterns = [
    { pattern: /Allow\s+(?:for\s+(?:this\s+)?(?:project|session)|always)/i, label: 'Allow for this project', kind: 'allow' },
    { pattern: /Allow\s+once/i, label: 'Allow once', kind: 'allow' },
    { pattern: /\bAlways\s+allow\b/i, label: 'Always allow', kind: 'allow' },
    { pattern: /(?:^|\s)Allow(?:\s|$)/i, label: 'Allow', kind: 'allow' },
    { pattern: /\bDeny\b/i, label: 'Deny', kind: 'deny' },
    { pattern: /\bReject\b/i, label: 'Reject', kind: 'deny' },
  ]

  let optIdx = 0
  for (const op of optionPatterns) {
    if (op.pattern.test(joined)) {
      optIdx++
      options.push({
        optionId: `opt-${optIdx}`,
        label: op.label,
        // Terminal value: we'll use arrow key navigation + Enter
        // The position in the list determines how many down arrows to press
        terminalValue: String(optIdx),
      })
    }
  }

  // If we didn't find specific options but have high confidence,
  // add default Allow/Deny options
  if (options.length === 0 && confidence >= 4) {
    options.push(
      { optionId: 'opt-1', label: 'Allow', terminalValue: '1' },
      { optionId: 'opt-2', label: 'Deny', terminalValue: '2' },
    )
  }

  // Extract the raw prompt context (last 10 lines)
  rawPrompt = lines.slice(-10).join('\n')

  return { toolName: toolName || 'Unknown', rawPrompt, options }
}

/**
 * Try to extract a session ID from terminal output.
 * The interactive CLI may print session info at startup.
 */
export function extractSessionId(text: string): string | null {
  // Pattern: "Session: <uuid>" or "session_id: <uuid>" or just a UUID in init context
  const match = text.match(/(?:session[_ ]?id|Session|Resuming session)[:\s]+([a-f0-9-]{36})/i)
  return match ? match[1] : null
}

/**
 * Detect if the CLI is showing its input prompt (ready for next message).
 * This indicates the current response is complete.
 *
 * The Ink-based CLI renders the prompt line as something like:
 *   "❯ "  or  "❯ ? for shortcuts"  or  "> "
 * After proper \r handling, the prompt should be a clean line.
 */
export function isInputPrompt(line: string): boolean {
  const cleaned = line.trim()
  if (cleaned === '❯' || cleaned === '>' || cleaned === '$') return true
  // Match prompt with trailing hint text (e.g. "❯ ? for shortcuts")
  if (/^[❯>]\s*(?:\?\s*for\s*shortcuts)?$/.test(cleaned)) return true
  // OpenClaw TUI status line indicating ready/idle
  if (/^gateway\s+connected\s*\|\s*idle\b/i.test(cleaned)) return true
  if (/^gateway\s+connected\s*\|\s*idle\/exit\b/i.test(cleaned)) return true
  return false
}

export function isUiChrome(line: string): boolean {
  const cleaned = line.trim()
  if (!cleaned) return true
  if (/^🦞\s+OpenClaw\b/i.test(cleaned)) return true
  if (/^\s*◇\s*Doctor warnings/i.test(cleaned)) return true
  if (/^openclaw\s+tui\b/i.test(cleaned)) return true
  if (/^\s*(?:connected|connecting|idle)\s*\|\s*idle\b/i.test(cleaned)) return true
  if (/^gateway\s+connected\s*\|\s*idle\/exit\b/i.test(cleaned)) return true
  if (/^gateway\s+connected\s*\|\s*idle\b/i.test(cleaned)) return true
  if (/^connected\s*\|\s*press\s+ctrl\+c\s+again\s+to\s+exit\b/i.test(cleaned)) return true
  if (/agent\s+[^\|]+\s+\|\s+session\s+[^\|]+/i.test(cleaned)) return true
  if (/\|\s+think\s+\w+\s+\|\s+tokens\s+/i.test(cleaned)) return true
  if (/^\s*tokens\s+\?\/\d+/i.test(cleaned)) return true
  if (/^\s*session\s+agent:/i.test(cleaned)) return true
  if (/^[╭│╰─┌└┃┏┗┐┘┤├┬┴┼]/.test(cleaned)) return true
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✳✶✻✽]/.test(cleaned)) return true
  if (/^\s*(?:Medium|Low|High)\s/.test(cleaned) && /model/i.test(cleaned)) return true

  // ─── Anchored rules ───
  //
  // Everything below used to match a bare substring anywhere in the line, which
  // meant an ordinary answer mentioning "processing", "MCP server", "/doctor"
  // or "Claude Max" was classified as chrome and dropped from the transcript
  // with no trace. A status line always has a recognisable *shape* — it starts
  // at the line boundary, or carries the status bar's `·` separator — so the
  // rules match on that shape instead of on the vocabulary alone.

  if (/^\/mcp\b/i.test(cleaned) || /^MCP server\b/i.test(cleaned)) return true
  if (/^Claude\s*Code\s*v/i.test(cleaned) || /^ClaudeCodev/i.test(cleaned)) return true
  if (/^[❯>$]\s*$/.test(cleaned)) return true
  if (/^\$[\d.]+\s+·/.test(cleaned)) return true
  if (/^esctointerrupt/i.test(cleaned)) return true

  // Prompt line with hint: "❯ ? for shortcuts", never a sentence about them.
  if (/^[❯>]?\s*\?\s*for\s+shortcuts\b/i.test(cleaned)) return true

  // Spinner label. The glyph rule above catches these while the glyph survives
  // ANSI stripping; this is the fallback for when it does not, so it needs the
  // CLI's own timing suffix or interrupt hint to distinguish
  // "✳ Thinking… (5s · esc to interrupt)" from "Here is my thinking".
  if (
    /^(?:zigzagging|thinking|processing|nebulizing|boondoggling)\b/i.test(cleaned) &&
    (/\(\s*\d+s\b/.test(cleaned) || /\besc\s+to\s+interrupt\b/i.test(cleaned) || /^\w+[….]{1,3}$/.test(cleaned))
  ) return true

  // Status bar fragments: "Opus 4.6 · Claude Max" — the `·` is the giveaway.
  if (/Opus\s*[\d.]+\s*·/i.test(cleaned)) return true
  if (/·\s*Claude\s*Max\b/i.test(cleaned)) return true

  // Settings issue / doctor notice, as its own line rather than in prose.
  if (/^(?:settings?\s+issue\b|\/doctor\b)/i.test(cleaned)) return true
  // Horizontal rules (all dashes/box chars)
  if (/^[─━▪\-=]{4,}/.test(cleaned)) return true
  // Only box-drawing / decoration chars
  if (/^[▗▖▘▝▀▄▌▐█░▒▓■□▪▫●○◆◇◈]+$/.test(cleaned)) return true
  return false
}

/**
 * Translate a ConnectionTarget into `openclaw tui` flags.
 *
 * The CLI's own rules, which we must not violate:
 *  - `--local` is mutually exclusive with `--url` / `--token` / `--password`.
 *  - `--url` is rejected unless `--token` or `--password` accompanies it
 *    (GatewayExplicitAuthRequiredError), so there is no way to name a URL
 *    on the command line without also putting a credential there.
 *
 * Because a command line is readable by any local process, the preferred path
 * emits nothing at all: when openclaw.json already targets this gateway with a
 * resolvable credential, the CLI resolves both itself and the secret never
 * leaves the config/environment.
 */
export function buildConnectionArgs(target: import('../../shared/types').ConnectionTarget | undefined): string[] {
  if (!target || target.mode === 'auto') return []

  if (target.mode === 'local') return ['--local']

  // Config already points here — let the CLI resolve it, keeping the
  // credential out of argv entirely.
  if (target.viaConfig) return []

  const args: string[] = []
  if (target.url) args.push('--url', target.url)

  if (target.token) {
    args.push('--token', target.token)
  } else if (target.password) {
    args.push('--password', target.password)
  } else if (target.url) {
    // Emitting a bare --url would be rejected by the CLI with a confusing
    // error. Fall back to config resolution instead of shipping a broken run.
    log('Connection target has a URL but no credential — falling back to CLI config resolution')
    return []
  }

  if (target.token || target.password) {
    log('WARNING: emitting an explicit gateway credential on the command line — visible in the process table')
  }

  return args
}

/** Mask credential values so the unconditional arg log never leaks a token. */
export function redactArgs(args: string[]): string[] {
  const secret = new Set(['--token', '--password'])
  return args.map((arg, i) => (i > 0 && secret.has(args[i - 1]) ? '<redacted>' : arg))
}

/**
 * Detect a gateway connectivity transition in the TUI status line.
 * These lines are otherwise classified as UI chrome and discarded, which is
 * why an unreachable gateway used to be invisible to the user.
 */
export function parseGatewayState(
  line: string,
): { state: import('../../shared/types').GatewayConnectionState; detail?: string } | null {
  const cleaned = line.trim()
  const disconnected = cleaned.match(/gateway\s+disconnected(?:\s*[:|-]\s*(.+))?$/i)
  if (disconnected) return { state: 'disconnected', detail: disconnected[1]?.trim() }
  if (/gateway\s+connecting\b/i.test(cleaned)) return { state: 'connecting' }
  if (/gateway\s+connected\b/i.test(cleaned)) return { state: 'connected' }
  // The status line is also rendered without the leading "gateway" word,
  // e.g. "connected | idle". isUiChrome already recognises that variant, so
  // missing it here would leave gatewayState 'unknown' on a healthy run.
  if (/^connecting\s*\|/i.test(cleaned)) return { state: 'connecting' }
  if (/^connected\s*\|/i.test(cleaned)) return { state: 'connected' }
  // Explicit auth/pairing rejections surface as disconnects with a reason.
  if (/pairing required|scope upgrade|missing scope/i.test(cleaned)) {
    return { state: 'disconnected', detail: cleaned }
  }
  return null
}

/**
 * Detect if a line looks like a tool call header from the interactive CLI.
 * Example: "⏳ Bash ls -la" or "✓ Read file.ts"
 */
export function parseToolCallLine(line: string): { toolName: string; input: string } | null {
  // Pattern: emoji/spinner + tool name + optional input
  const match = line.match(/^\s*(?:⏳|✓|✗|⚡|🔧|Running|Executing)\s+([A-Za-z_][\w-]*)\s*(.*)$/i)
    || line.match(/^\s*(?:Tool|Using):\s*([A-Za-z_][\w-]*)\s*(.*)$/i)
  if (match) {
    return { toolName: match[1], input: match[2].trim() }
  }
  return null
}

// ─── Run Handle ───

export interface PtyRunHandle {
  runId: string
  sessionId: string | null
  pty: import('node-pty').IPty
  pid: number
  startedAt: number
  /** Ring buffer of raw PTY output for diagnostics */
  rawOutputTail: string[]
  /** Ring buffer of stderr-like error lines */
  stderrTail: string[]
  /** Count of tool calls seen */
  toolCallCount: number
  /** Current pending permission prompt */
  pendingPermission: ParsedPermission | null
  /** Permission flow phase */
  permissionPhase: 'idle' | 'detecting' | 'waiting_user' | 'answered'
  /** Rolling window of cleaned lines for parser context */
  ptyBuffer: string[]
  /** Timer for permission timeout */
  permissionTimeout: ReturnType<typeof setTimeout> | null
  /** Accumulated text since last flush (for debounced text_chunk emission) */
  textAccumulator: string
  /** Whether we've seen any non-chrome content for this run */
  seenContent: boolean
  /** Whether we've seen the initial welcome/init output */
  pastInit: boolean
  /** Whether we've emitted session_init */
  emittedSessionInit: boolean
  /** Track which options are in the current selector for arrow-key navigation */
  selectorOptions: string[]
  /** Currently highlighted option index in the terminal selector */
  currentOptionIndex: number
  /** Whether task_complete has already been emitted for this run */
  runCompleteEmitted: boolean
  /** Quiescence timer used to avoid premature completion */
  quiescenceTimer: ReturnType<typeof setTimeout> | null
  /** Last PTY output timestamp */
  lastOutputAt: number
  /** Last meaningful output timestamp (ignores OpenClaw status redraw noise) */
  lastMeaningfulOutputAt: number
  /** Current prompt snippet used to detect the echoed user input */
  promptSnippet: string
  /** Full prompt line (last non-empty line) for OpenClaw echo detection */
  promptLine: string
  /** Normalized prompt for fuzzy matching in OpenClaw TUI */
  promptKey: string
  /** Whether we saw an echoed prompt for current request */
  sawPromptEcho: boolean
  /** OpenClaw native TUI mode (different output semantics) */
  openclawTuiMode: boolean
  /** OpenClaw idle marker has appeared for this run */
  sawIdleMarker: boolean
  /** Last timestamp where TUI signaled active work */
  lastWorkingSignalAt: number
  /** Latest gateway connectivity state parsed from the TUI status line */
  gatewayState: import('../../shared/types').GatewayConnectionState
  /** Reason text accompanying a disconnect, when the TUI supplied one */
  gatewayDetail: string | null
  /**
   * Which terminal event was emitted. `runCompleteEmitted` alone cannot say,
   * because it is set on both the success and failure paths — reading it as
   * "completed" would let the exit handler overwrite a failure with success.
   */
  terminalOutcome: 'complete' | 'error' | null
  /** Connection mode this run was dispatched with, for failure diagnosis */
  connectionMode: import('../../shared/types').ConnectionMode
}

// ─── PtyRunManager ───

export class PtyRunManager extends EventEmitter {
  private activeRuns = new Map<string, PtyRunHandle>()
  private _finishedRuns = new Map<string, PtyRunHandle>()
  private runtime: CliRuntime
  private recentLineSet = new Set<string>()
  private recentLines: string[] = []

  constructor() {
    super()
    this.runtime = getCliRuntime()
    this._ensureSpawnHelperExecutable()
    log(`CLI runtime: ${this.runtime.label} (kind=${this.runtime.kind}, resolved=${this.runtime.resolved})`)
  }

  private _rememberLine(line: string): void {
    if (!line) return
    if (this.recentLineSet.has(line)) return
    this.recentLineSet.add(line)
    this.recentLines.push(line)
    if (this.recentLines.length > 300) {
      const drop = this.recentLines.shift()
      if (drop) this.recentLineSet.delete(drop)
    }
  }

  private _isDuplicateLine(line: string): boolean {
    return this.recentLineSet.has(line)
  }

  // (moved to class methods below)

  /**
   * node-pty prebuilt spawn-helper may lose execute bit depending on install/archive flow.
   * Ensure it's executable at runtime to avoid "posix_spawnp failed".
   */
  private _ensureSpawnHelperExecutable(): void {
    try {
      const pkgPath = require.resolve('node-pty/package.json')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path')
      const helperPath = path.join(
        path.dirname(pkgPath),
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      )
      if (!existsSync(helperPath)) return
      const st = statSync(helperPath)
      const isExecutable = (st.mode & 0o111) !== 0
      if (!isExecutable) {
        chmodSync(helperPath, 0o755)
        log(`Fixed spawn-helper permissions: ${helperPath}`)
      }
    } catch (err) {
      log(`spawn-helper permission check failed: ${(err as Error).message}`)
    }
  }

  private _getEnv(): NodeJS.ProcessEnv {
    const env = getCliEnv(this.runtime.extraEnv)
    const binDir = this.runtime.binDir
    if (binDir && env.PATH && !env.PATH.split(delimiter).includes(binDir)) {
      env.PATH = `${binDir}${delimiter}${env.PATH}`
    }

    return env
  }

  startRun(requestId: string, options: RunOptions): PtyRunHandle {
    if (!pty) {
      throw new Error('node-pty is not available — cannot use PTY transport')
    }

    const cwd = options.projectPath === '~' ? homedir() : options.projectPath

    // Authoritative — resolved once at startup. Do not sniff the binary path:
    // on Windows `command` is the Node executable, not anything named "openclaw".
    const isOpenclaw = this.runtime.kind === 'openclaw'
    const args: string[] = [...this.runtime.prefixArgs]

    if (isOpenclaw) {
      // OpenClaw does not support Claude-style PTY flags. Use native TUI mode.
      // The session key must be per-tab: a shared key mixes conversations
      // together once sessions live on a gateway rather than on this machine.
      args.push('tui', '--message', options.prompt, '--session', options.sessionId || `clui-${requestId}`)
      args.push(...buildConnectionArgs(options.connection))
    } else {
      // Claude-style interactive mode (no -p flag)
      args.push('--permission-mode', 'default')
      if (options.sessionId) {
        args.push('--resume', options.sessionId)
      }
      if (options.model) {
        args.push('--model', options.model)
      }
      if (options.allowedTools?.length) {
        args.push('--allowedTools', options.allowedTools.join(','))
      }
      if (options.systemPrompt) {
        args.push('--system-prompt', options.systemPrompt)
      }
      // Pass prompt as positional argument
      args.push(options.prompt)
    }

    log(`Starting PTY run ${requestId}: ${this.runtime.command} ${redactArgs(args).join(' ')}`)
    log(`Prompt: ${options.prompt.substring(0, 200)}`)

    const ptyProcess = pty.spawn(this.runtime.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: this._getEnv(),
    })

    log(`Spawned PTY PID: ${ptyProcess.pid}`)

    const handle: PtyRunHandle = {
      runId: requestId,
      sessionId: options.sessionId || null,
      pty: ptyProcess,
      pid: ptyProcess.pid,
      startedAt: Date.now(),
      rawOutputTail: [],
      stderrTail: [],
      toolCallCount: 0,
      pendingPermission: null,
      permissionPhase: 'idle',
      ptyBuffer: [],
      permissionTimeout: null,
      textAccumulator: '',
      seenContent: false,
      pastInit: false,
      emittedSessionInit: false,
      selectorOptions: [],
      currentOptionIndex: 0,
      runCompleteEmitted: false,
      quiescenceTimer: null,
      lastOutputAt: Date.now(),
      lastMeaningfulOutputAt: Date.now(),
      promptSnippet: options.prompt.trim().toLowerCase().slice(0, 24),
      promptLine: (() => {
        const lines = options.prompt.split('\n').map((l) => l.trim()).filter(Boolean)
        return (lines[lines.length - 1] || options.prompt).trim()
      })(),
      promptKey: (() => {
        const lines = options.prompt.split('\n').map((l) => l.trim()).filter(Boolean)
        const line = (lines[lines.length - 1] || options.prompt).trim()
        return normalizeForMatch(line).norm
      })(),
      sawPromptEcho: false,
      openclawTuiMode: isOpenclaw,
      sawIdleMarker: false,
      lastWorkingSignalAt: Date.now(),
      gatewayState: 'unknown',
      gatewayDetail: null,
      terminalOutcome: null,
      connectionMode: options.connection?.mode || 'auto',
    }

    if (isOpenclaw) {
      handle.sessionId = options.sessionId || `clui-${requestId}`
      handle.emittedSessionInit = true
      this.emit('normalized', requestId, {
        type: 'session_init',
        sessionId: handle.sessionId,
        tools: [],
        model: options.model || '',
        mcpServers: [],
        skills: [],
        version: '',
      })
    }

    // ─── PTY output parser pipeline ───
    let lineBuffer = ''

    ptyProcess.onData((data: string) => {
      // Raw diagnostics
      this._ringPush(handle.rawOutputTail, data.substring(0, 500))

      // Ink/TUI uses \r to redraw the current line (cursor back to col 0).
      // PTY output commonly uses \r\r\n as line endings (Ink reset + newline).
      // Strategy: scan for \n to emit completed lines; treat \r immediately
      // before \n (or \r\n) as part of the line ending, not a redraw.
      // Only a \r followed by printable text is a true Ink redraw.
      const chars = data
      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci]
        if (ch === '\n') {
          // Emit completed line (strip any trailing \r that was buffered)
          const completed = lineBuffer.endsWith('\r')
            ? lineBuffer.slice(0, -1)
            : lineBuffer
          lineBuffer = ''
          this._processLine(requestId, handle, completed)
        } else if (ch === '\r') {
          // Look ahead: if next char is \n or \r (part of \r\r\n), just
          // append \r to buffer so the \n branch can strip it.
          const next = ci + 1 < chars.length ? chars[ci + 1] : null
          if (next === '\n' || next === '\r') {
            // Part of line ending sequence — keep in buffer for \n to strip
            lineBuffer += '\r'
          } else if (next === null) {
            // End of chunk — we don't know what comes next, buffer it
            lineBuffer += '\r'
          } else {
            // \r followed by printable text → Ink redraw: reset line
            lineBuffer = ''
          }
        } else {
          lineBuffer += ch
        }
      }

      // Also process the current incomplete line for permission detection
      // (permission prompts may not end with newline)
      if (lineBuffer.length > 0) {
        const cleaned = stripAnsi(lineBuffer).trim()
        if (cleaned.length > 0) {
          this._checkPermissionInBuffer(requestId, handle, cleaned)
          // OpenClaw TUI often redraws the input prompt without a trailing newline.
          // Record prompt markers seen in the live line buffer so quiescence
          // completion can still detect "ready for next input".
          if (isInputPrompt(cleaned)) {
            if (handle.ptyBuffer.length === 0 || handle.ptyBuffer[handle.ptyBuffer.length - 1] !== cleaned) {
              this._ringPushBuffer(handle.ptyBuffer, cleaned)
            }
            handle.lastMeaningfulOutputAt = Date.now()
            if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
            handle.quiescenceTimer = setTimeout(
              () => this._checkQuiescenceCompletion(requestId, handle),
              QUIESCENCE_MS,
            )
          }
        }
      }
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      log(`PTY exited [${requestId}]: code=${exitCode} signal=${signal}`)

      // Clear permission timeout
      if (handle.permissionTimeout) {
        clearTimeout(handle.permissionTimeout)
        handle.permissionTimeout = null
      }
      if (handle.quiescenceTimer) {
        clearTimeout(handle.quiescenceTimer)
        handle.quiescenceTimer = null
      }

      // Flush any accumulated text
      this._flushText(requestId, handle, true)

      // Emit the terminal event if we haven't already
      this._emitTerminal(requestId, handle)

      // Move to finished runs
      this._finishedRuns.set(requestId, handle)
      this.activeRuns.delete(requestId)
      this.emit('exit', requestId, exitCode, signal, handle.sessionId)

      setTimeout(() => this._finishedRuns.delete(requestId), 5000)
    })

    this.activeRuns.set(requestId, handle)
    return handle
  }

  /**
   * Process a single line of PTY output.
   */
  private _processLine(requestId: string, handle: PtyRunHandle, rawLine: string): void {
    let cleaned = stripAnsi(rawLine).trim()
    if (cleaned.length === 0) return
    handle.lastOutputAt = Date.now()

    // OpenClaw TUI state hints used to avoid premature completion.
    if (handle.openclawTuiMode) {
      // Read connectivity BEFORE the chrome filter below drops these lines.
      // Losing them is what made an unreachable gateway look like a success.
      const gw = parseGatewayState(cleaned)
      if (gw && gw.state !== handle.gatewayState) {
        handle.gatewayState = gw.state
        handle.gatewayDetail = gw.detail || null
        log(`Gateway state [${requestId}]: ${gw.state}${gw.detail ? ` (${gw.detail})` : ''}`)
        this.emit('normalized', requestId, {
          type: 'gateway_state',
          state: gw.state,
          detail: gw.detail,
        })
      }

      if (/gateway\s+connected\s*\|\s*idle(?:\/exit)?\b/i.test(cleaned)) {
        handle.sawIdleMarker = true
      }
      if (/\bworking\b|\bthinking\b|\brunning\b|\bexecuting\b|\bprocessing\b/i.test(cleaned)) {
        handle.lastWorkingSignalAt = Date.now()
      }
    }

    const promptMarker = isInputPrompt(cleaned)
    // In OpenClaw TUI mode, keep prompt markers so quiescence-complete can fire.
    // Other chrome/status lines are still ignored.
    if (handle.openclawTuiMode && isUiChrome(cleaned) && !promptMarker) return

    // Ignore terminal mode toggles and redraw control fragments.
    if (/^(?:\?[0-9;?]*[a-zA-Z])+$/i.test(cleaned)) return

    // Deduplicate exact redraw duplicates.
    if (handle.ptyBuffer.length > 0 && handle.ptyBuffer[handle.ptyBuffer.length - 1] === cleaned) return

    // Push to rolling buffer
    this._ringPushBuffer(handle.ptyBuffer, cleaned)
    if (!isUiChrome(cleaned) || promptMarker) {
      handle.lastMeaningfulOutputAt = Date.now()
      if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
      handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS)
    }

    log(`PTY line [${requestId}]: ${cleaned.substring(0, 200)}`)

    // ─── Try to extract session ID ───
    if (!handle.emittedSessionInit) {
      const sid = extractSessionId(cleaned)
      if (sid) {
        handle.sessionId = sid
        handle.emittedSessionInit = true
        this.emit('normalized', requestId, {
          type: 'session_init',
          sessionId: sid,
          tools: [],
          model: '',
          mcpServers: [],
          skills: [],
          version: '',
        })
      }
    }

    // ─── Skip init/welcome output ───
    if (!handle.pastInit) {
      if (handle.openclawTuiMode) {
        if (!handle.promptKey) return
        const { norm, map } = normalizeForMatch(cleaned)
        const idx = norm.lastIndexOf(handle.promptKey)
        if (idx === -1) {
          // Ignore all history until we see the current prompt echoed.
          return
        }

        handle.sawPromptEcho = true
        handle.textAccumulator = ''
        handle.ptyBuffer = []
        handle.seenContent = false
        handle.pastInit = true

        const endNorm = idx + handle.promptKey.length - 1
        const endOrig = map[endNorm] ?? cleaned.length - 1
        const after = cleaned.slice(endOrig + 1).trim()
        if (!after) return
        // Treat text after the last prompt echo as the actual response start.
        cleaned = after
      } else {
        // Wait until we see the echoed prompt for this request.
        if (/^[❯>]\s+/.test(cleaned)) {
          // Resume sessions may echo prior context, not the exact current prompt text.
          // Any echoed input prompt means init shell is ready.
          handle.sawPromptEcho = true
        }
        // Start parsing actual response only after a message bullet appears post-echo.
        if (handle.sawPromptEcho && cleaned.startsWith('⏺')) {
          handle.pastInit = true
        } else {
          return
        }
      }
    }

    // ─── Permission phase: collecting detection context ───
    if (handle.permissionPhase === 'detecting' || handle.permissionPhase === 'idle') {
      // The detector reports whether it emitted, rather than the caller
      // re-reading `permissionPhase`: after the `if` above, the compiler has
      // narrowed that field to 'idle' | 'detecting' and cannot see the
      // mutation, so the old check was statically dead.
      if (this._checkPermissionInBuffer(requestId, handle, cleaned)) {
        return // Permission prompt detected and emitted
      }
    }

    // ─── Detect tool calls ───
    const toolCall = parseToolCallLine(cleaned)
    if (toolCall) {
      handle.toolCallCount++
      this._flushText(requestId, handle)
      this.emit('normalized', requestId, {
        type: 'tool_call',
        toolName: toolCall.toolName,
        toolId: `pty-tool-${handle.toolCallCount}`,
        index: handle.toolCallCount - 1,
      })

      // Also emit tool_call_complete shortly after (we can't know exact timing from PTY)
      setTimeout(() => {
        this.emit('normalized', requestId, {
          type: 'tool_call_complete',
          index: handle.toolCallCount - 1,
        })
      }, 100)
      return
    }

    // ─── Accumulate text output ───
    if (isUiChrome(cleaned)) return
    if (handle.openclawTuiMode && handle.sawPromptEcho && this._isDuplicateLine(cleaned)) {
      return
    }

    // Accumulate text for debounced emission
    if (handle.textAccumulator.length > 0) {
      handle.textAccumulator += '\n'
    }
    const textLine = cleaned.startsWith('⏺') ? cleaned.replace(/^⏺\s*/, '') : cleaned
    handle.textAccumulator += textLine
    handle.seenContent = true
    if (handle.openclawTuiMode) this._rememberLine(cleaned)

    // Emit text chunks periodically (debounce 50ms)
    this._scheduleTextFlush(requestId, handle)
  }

  /**
   * Emit the single terminal event for a run.
   *
   * A run that produced no content while the gateway was never reachable is a
   * failure, not an empty success. Reporting task_complete in that case is
   * what made connection problems indistinguishable from a silent agent.
   */
  private _emitTerminal(requestId: string, handle: PtyRunHandle): void {
    if (handle.runCompleteEmitted) return
    handle.runCompleteEmitted = true

    // Only diagnose a gateway problem when this run actually targeted a
    // gateway and we saw positive evidence of failure. `--local` runs have no
    // gateway at all, and the TUI's status line has variants that never spell
    // the word "gateway" — treating either as a failure would blame a gateway
    // the user deliberately bypassed.
    const targetedGateway = handle.openclawTuiMode && handle.connectionMode !== 'local'
    const failed =
      targetedGateway
      && !handle.seenContent
      && (handle.gatewayState === 'disconnected'
        || (handle.gatewayState === 'unknown' && !handle.sawIdleMarker))

    if (failed) {
      handle.terminalOutcome = 'error'
      const detail = handle.gatewayDetail ? ` — ${handle.gatewayDetail}` : ''
      const reason =
        handle.gatewayState === 'disconnected'
          ? `Gateway disconnected${detail}`
          : `No response from the agent gateway${detail}`
      log(`Run ${requestId} failed: ${reason}`)
      this.emit('normalized', requestId, {
        type: 'error',
        message: `${reason}. Check the gateway connection in Control Center.`,
        isError: true,
        sessionId: handle.sessionId || undefined,
      })
      return
    }

    handle.terminalOutcome = 'complete'
    this.emit('normalized', requestId, {
      type: 'task_complete',
      result: '',
      costUsd: 0,
      durationMs: Date.now() - handle.startedAt,
      numTurns: 1,
      usage: {},
      sessionId: handle.sessionId || '',
    })
  }

  private _checkQuiescenceCompletion(requestId: string, handle: PtyRunHandle): void {
    if (!this.activeRuns.has(requestId)) return
    if (!handle.pastInit || handle.permissionPhase === 'waiting_user') return
    const silenceMs = Date.now() - handle.lastMeaningfulOutputAt
    if (silenceMs < QUIESCENCE_MS - 50) {
      if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
      handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS)
      return
    }

    // OpenClaw can redraw prompt/status before real answer text arrives.
    // Do not complete early in that phase or the response is dropped.
    if (handle.openclawTuiMode && !handle.seenContent) {
      const waitedMs = Date.now() - handle.startedAt
      if (waitedMs < 45000) {
        if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
        handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS)
        return
      }
    }

    const lastLines = handle.ptyBuffer.slice(-3)
    const hasPromptMarker = lastLines.some((l) => isInputPrompt(l))
    const openclawSilence = handle.openclawTuiMode
      && handle.seenContent
      && !hasPromptMarker
      && (Date.now() - handle.lastMeaningfulOutputAt >= QUIESCENCE_MS * 5)
      && (Date.now() - handle.lastWorkingSignalAt >= QUIESCENCE_MS * 5)

    if (!hasPromptMarker && !openclawSilence) {
      // In OpenClaw TUI mode there may be no explicit prompt marker.
      // Keep polling until silence threshold is reached, then complete.
      if (handle.openclawTuiMode) {
        // Prefer explicit idle marker before completing.
        if (!handle.sawIdleMarker) {
          if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
          handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS)
          return
        }
        if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer)
        handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS)
      }
      return
    }

    this._flushText(requestId, handle, true)
    this._emitTerminal(requestId, handle)

    try { handle.pty.write('/exit\n') } catch {}
    setTimeout(() => {
      if (this.activeRuns.has(requestId)) {
        try { handle.pty.kill() } catch {}
      }
    }, 3000)
  }

  private _textFlushTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private _scheduleTextFlush(requestId: string, handle: PtyRunHandle): void {
    if (this._textFlushTimers.has(requestId)) return

    const timer = setTimeout(() => {
      this._textFlushTimers.delete(requestId)
      this._flushText(requestId, handle)
    }, 50)

    this._textFlushTimers.set(requestId, timer)
  }

  private _flushText(requestId: string, handle: PtyRunHandle, force = false): void {
    const timer = this._textFlushTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this._textFlushTimers.delete(requestId)
    }

    if (handle.openclawTuiMode && !force) return

    if (handle.textAccumulator.length > 0) {
      this.emit('normalized', requestId, {
        type: 'text_chunk',
        text: handle.textAccumulator,
      })
      handle.textAccumulator = ''
    }
  }

  /**
   * Check the current buffer for permission prompt patterns.
   */
  /** @returns true when a permission prompt was detected and emitted. */
  private _checkPermissionInBuffer(requestId: string, handle: PtyRunHandle, currentLine: string): boolean {
    // The detector below scores on Claude Code's Ink strings ("Claude wants to
    // use", "❯ Allow"), which the OpenClaw TUI never emits. Running it there
    // produces only false positives — and a false positive makes
    // respondToPermission() type Enter into the agent's message box.
    // Gateway-side approvals (exec.approval.*) are the correct mechanism and
    // are not reachable over this transport.
    if (handle.openclawTuiMode) return false

    // Add current line to detection context
    const detectionWindow = [...handle.ptyBuffer.slice(-10), currentLine]

    const permission = detectPermissionPrompt(detectionWindow)
    if (!permission) {
      // Check for permission-adjacent keywords to enter detecting phase
      const hasKeyword = /\b(?:permission|approve|allow|deny)\b/i.test(currentLine)
      if (hasKeyword && handle.permissionPhase === 'idle') {
        handle.permissionPhase = 'detecting'
      }
      return false
    }

    // Permission prompt detected!
    log(`Permission prompt detected [${requestId}]: tool=${permission.toolName}, options=${permission.options.length}`)

    handle.pendingPermission = permission
    handle.permissionPhase = 'waiting_user'

    // Flush any accumulated text first
    this._flushText(requestId, handle, true)

    // Generate a unique question ID
    const questionId = `pty-perm-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    // Emit permission_request event
    this.emit('normalized', requestId, {
      type: 'permission_request',
      questionId,
      toolName: permission.toolName,
      toolDescription: permission.rawPrompt,
      options: permission.options.map((o) => ({
        id: o.optionId,
        label: o.label,
        kind: o.label.toLowerCase().includes('deny') || o.label.toLowerCase().includes('reject') ? 'deny' : 'allow',
      })),
    })

    // Set timeout for user response
    handle.permissionTimeout = setTimeout(() => {
      if (handle.permissionPhase === 'waiting_user') {
        log(`Permission timeout [${requestId}] — auto-denying`)
        this.emit('normalized', requestId, {
          type: 'text_chunk',
          text: '\n[Permission timed out — automatically denied after 5 minutes]\n',
        })
        // Send Escape to dismiss the prompt
        try {
          handle.pty.write('\x1b')
        } catch {}
        handle.permissionPhase = 'idle'
        handle.pendingPermission = null
      }
    }, PERMISSION_TIMEOUT_MS)

    return true
  }

  /**
   * Respond to a permission prompt by sending keystrokes to the PTY.
   */
  respondToPermission(requestId: string, _questionId: string, optionId: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) {
      log(`respondToPermission: no active run for ${requestId}`)
      return false
    }

    // Never write raw keystrokes into an OpenClaw TUI. It has no Ink selector
    // to drive, so anything we send lands in the message box instead.
    if (handle.openclawTuiMode) {
      log(`respondToPermission: refusing to write keystrokes in OpenClaw TUI mode (${requestId})`)
      return false
    }

    if (handle.permissionPhase !== 'waiting_user' || !handle.pendingPermission) {
      log(`respondToPermission: not waiting for permission (phase=${handle.permissionPhase})`)
      return false
    }

    // Clear timeout
    if (handle.permissionTimeout) {
      clearTimeout(handle.permissionTimeout)
      handle.permissionTimeout = null
    }

    const option = handle.pendingPermission.options.find((o) => o.optionId === optionId)
    if (!option) {
      log(`respondToPermission: option ${optionId} not found`)
      return false
    }

    log(`respondToPermission [${requestId}]: optionId=${optionId}, label=${option.label}`)

    // ─── Send keystrokes to PTY ───
    // The Claude interactive CLI uses Ink's Select component.
    // The first option is typically "Allow for this project" and is pre-selected.
    // To select a different option, we press Down arrow keys then Enter.

    const optionIndex = handle.pendingPermission.options.indexOf(option)
    const isAllow = option.label.toLowerCase().includes('allow') || option.label.toLowerCase().includes('yes')
    const isDeny = option.label.toLowerCase().includes('deny') || option.label.toLowerCase().includes('reject')

    try {
      if (isDeny) {
        // Try sending 'n' first (common shortcut for deny)
        // If that doesn't work, navigate with arrow keys
        // Send Escape first to clear any state, then 'n'
        handle.pty.write('n')
      } else if (isAllow && optionIndex === 0) {
        // First option (typically already selected) — just press Enter
        handle.pty.write('\r')
      } else {
        // Navigate to the option with arrow keys then press Enter
        for (let i = 0; i < optionIndex; i++) {
          handle.pty.write('\x1b[B') // Down arrow
        }
        // Small delay then Enter
        setTimeout(() => {
          try { handle.pty.write('\r') } catch {}
        }, 50)
      }
    } catch (err) {
      log(`respondToPermission: write error: ${(err as Error).message}`)
      return false
    }

    handle.permissionPhase = 'answered'
    handle.pendingPermission = null

    // After answering, reset to idle for next potential permission
    setTimeout(() => {
      if (handle.permissionPhase === 'answered') {
        handle.permissionPhase = 'idle'
      }
    }, 500)

    return true
  }

  /**
   * Cancel a running PTY process.
   */
  cancel(requestId: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false

    log(`Cancelling PTY run ${requestId}`)

    // Clear permission timeout
    if (handle.permissionTimeout) {
      clearTimeout(handle.permissionTimeout)
      handle.permissionTimeout = null
    }

    // Send SIGINT (Ctrl+C)
    try {
      handle.pty.write('\x03') // Ctrl+C
    } catch {}

    // Fallback: kill after 5s
    setTimeout(() => {
      if (this.activeRuns.has(requestId)) {
        log(`Force killing PTY run ${requestId}`)
        try {
          handle.pty.kill()
        } catch {}
      }
    }, 5000)

    return true
  }

  /**
   * Write arbitrary data to PTY stdin (for follow-up messages, etc.)
   */
  writeToStdin(requestId: string, message: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false

    log(`Writing to PTY stdin [${requestId}]: ${message.substring(0, 200)}`)
    try {
      handle.pty.write(message)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get an enriched error object for a failed PTY run.
   */
  getEnrichedError(requestId: string, exitCode: number | null): EnrichedError {
    const handle = this.activeRuns.get(requestId) || this._finishedRuns.get(requestId)
    return {
      message: `PTY run failed with exit code ${exitCode}`,
      stderrTail: handle?.stderrTail.slice(-20) || [],
      stdoutTail: handle?.rawOutputTail.slice(-20) || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
      sawPermissionRequest: handle?.permissionPhase !== 'idle' || false,
      permissionDenials: [],
    }
  }

  isRunning(requestId: string): boolean {
    return this.activeRuns.has(requestId)
  }

  getHandle(requestId: string): PtyRunHandle | null {
    return this.activeRuns.get(requestId) || this._finishedRuns.get(requestId) || null
  }

  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys())
  }

  private _ringPush(buffer: string[], line: string): void {
    buffer.push(line)
    if (buffer.length > MAX_RING_LINES) buffer.shift()
  }

  private _ringPushBuffer(buffer: string[], line: string): void {
    buffer.push(line)
    if (buffer.length > PTY_BUFFER_SIZE) buffer.shift()
  }
}
