/**
 * AgentRunManager: structured JSON transport for the OpenClaw CLI.
 *
 * Runs one turn with `openclaw agent --json` and reads the reply out of the
 * CLI's own response object.
 *
 * This exists because the alternative — PtyRunManager — scrapes the TUI, and a
 * TUI is a screen, not a stream. It repaints, it truncates lines at the
 * terminal width, it redraws the prompt echo and the token counter between
 * fragments of the answer. Reassembling a message from those frames produced
 * replies with the table separator cut off mid-row, the session id and status
 * line spliced into the prose, and paragraphs run together — damage no parser
 * downstream can undo, because the missing characters were never sent.
 *
 * `--json` reserves stdout for one response and routes diagnostics to stderr,
 * so the markdown arrives exactly as the agent wrote it.
 *
 * Trade-off: this is one-shot, so text lands when the turn finishes rather than
 * token by token. The TUI path never streamed either (it could only flush at
 * quiescence), so nothing is lost — and completion is now a process exit
 * instead of a silence heuristic.
 *
 * Events emitted (identical contract to RunManager/PtyRunManager):
 *  - 'normalized' (runId, NormalizedEvent)
 *  - 'exit'       (runId, code, signal, sessionId)
 *  - 'error'      (runId, Error)
 */

import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { delimiter } from 'path'
import { log as _log } from '../logger'
import { getCliEnv } from '../cli-env'
import { getCliRuntime, type CliRuntime } from '../openclaw/runtime'
import type {
  RunOptions,
  EnrichedError,
  GatewayConnectionState,
  UsageData,
} from '../../shared/types'

const MAX_RING_LINES = 100

function log(msg: string): void {
  _log('AgentRunManager', msg)
}

// ─── CLI response shapes ───
//
// Gateway-backed runs return the gateway envelope; embedded (`--local`) runs
// and embedded fallbacks put the same payloads at the top level. Both are read
// defensively — an unknown field is ignored, never fatal.

interface AgentPayload {
  text?: string
  mediaUrl?: string | null
}

interface AgentMeta {
  durationMs?: number
  agentMeta?: {
    sessionId?: string
    model?: string
    provider?: string
    usage?: { input?: number; output?: number; total?: number }
    lastCallUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  }
  transport?: string
  fallbackFrom?: string
  fallbackReason?: string
}

interface AgentJsonResponse {
  status?: string
  runId?: string
  summary?: string
  payloads?: AgentPayload[]
  meta?: AgentMeta
  error?: string
  result?: {
    payloads?: AgentPayload[]
    meta?: AgentMeta
  }
}

export interface AgentRunHandle {
  runId: string
  sessionId: string | null
  process: ChildProcess
  pid: number | null
  startedAt: number
  stdoutTail: string[]
  stderrTail: string[]
  /** Raw stdout, accumulated until exit — the JSON response arrives whole. */
  stdout: string
  /** Set once a terminal event was emitted, so exit doesn't emit a second. */
  terminalOutcome: 'complete' | 'error' | null
  /** True when the user cancelled this run. */
  cancelled: boolean
  connectionMode: import('../../shared/types').ConnectionMode
}

/**
 * Extract the response object from stdout.
 *
 * `--json` promises stdout carries only the response, but a stray banner from
 * a plugin would otherwise poison the whole reply, so the first parse attempt
 * falls back to scanning for the outermost JSON object.
 */
function parseResponse(stdout: string): AgentJsonResponse | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed) as AgentJsonResponse
  } catch {
    // Fall through to the brace scan.
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as AgentJsonResponse
  } catch {
    return null
  }
}

/** Payloads live at `result.payloads` (gateway) or `payloads` (embedded). */
function extractPayloads(res: AgentJsonResponse): AgentPayload[] {
  const fromResult = res.result?.payloads
  if (Array.isArray(fromResult)) return fromResult
  if (Array.isArray(res.payloads)) return res.payloads
  return []
}

function extractMeta(res: AgentJsonResponse): AgentMeta {
  return res.result?.meta || res.meta || {}
}

/**
 * Render one payload as markdown.
 *
 * Media is appended as markdown rather than dropped, but only when it is a URL
 * the renderer can actually resolve — a gateway-local file path would render as
 * a broken image in a window running on a different machine.
 */
function payloadToMarkdown(payload: AgentPayload): string {
  const text = typeof payload.text === 'string' ? payload.text : ''
  const media = typeof payload.mediaUrl === 'string' ? payload.mediaUrl.trim() : ''
  if (!media || !/^https?:\/\//i.test(media)) return text

  const isImage = /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(media)
  const embed = isImage ? `![](${media})` : `[Attachment](${media})`
  return text ? `${text}\n\n${embed}` : embed
}

/** Join multiple payloads as separate blocks so their markdown stays valid. */
function payloadsToMarkdown(payloads: AgentPayload[]): string {
  return payloads
    .map(payloadToMarkdown)
    .filter((t) => t.trim().length > 0)
    .join('\n\n')
}

function toUsageData(meta: AgentMeta): UsageData {
  const usage = meta.agentMeta?.usage
  const last = meta.agentMeta?.lastCallUsage
  if (!usage && !last) return {}
  return {
    input_tokens: usage?.input ?? last?.input,
    output_tokens: usage?.output ?? last?.output,
    cache_read_input_tokens: last?.cacheRead,
    cache_creation_input_tokens: last?.cacheWrite,
  }
}

/**
 * Turn a non-ok response into a sentence worth showing the user.
 * `in_flight` is its own case: the run was refused as a duplicate, which is not
 * an agent failure and should not read like one.
 */
function describeFailure(res: AgentJsonResponse): string {
  if (res.status === 'in_flight') {
    return 'That session already has a turn in flight — wait for it to finish before sending another.'
  }
  const detail = res.error || res.summary
  return detail ? `Agent run failed: ${detail}` : 'Agent run failed with no reply.'
}

export class AgentRunManager extends EventEmitter {
  private activeRuns = new Map<string, AgentRunHandle>()
  /** Holds recently-finished runs so diagnostics survive past process exit. */
  private _finishedRuns = new Map<string, AgentRunHandle>()
  private runtime: CliRuntime

  constructor() {
    super()
    this.runtime = getCliRuntime()
    log(`CLI runtime: ${this.runtime.label}`)
  }

  private _getEnv(): NodeJS.ProcessEnv {
    const env = getCliEnv(this.runtime.extraEnv)
    const binDir = this.runtime.binDir
    if (binDir && env.PATH && !env.PATH.split(delimiter).includes(binDir)) {
      env.PATH = `${binDir}${delimiter}${env.PATH}`
    }
    return env
  }

  /**
   * Build the argv for one turn.
   *
   * `openclaw agent` has no `--url`/`--token`, so an explicitly addressed
   * gateway resolves through the CLI's own config exactly as the `viaConfig`
   * case already did. That is the path that keeps a credential out of the
   * process table anyway; only `--local` needs to be stated on the command line.
   */
  private _buildArgs(options: RunOptions, sessionKey: string): string[] {
    const args = ['agent', '--json', '--session-key', sessionKey, '--message', options.prompt]

    if (options.model) args.push('--model', options.model)
    if (options.connection?.mode === 'local') args.push('--local')

    return args
  }

  startRun(requestId: string, options: RunOptions): AgentRunHandle {
    const cwd = options.projectPath === '~' ? homedir() : options.projectPath
    const sessionKey = options.sessionId || `clui-${requestId}`
    const args = this._buildArgs(options, sessionKey)
    const spawnArgs = [...this.runtime.prefixArgs, ...args]

    log(`Starting agent run ${requestId} (session=${sessionKey}, mode=${options.connection?.mode || 'auto'})`)

    const child = spawn(this.runtime.command, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: this._getEnv(),
    })

    const handle: AgentRunHandle = {
      runId: requestId,
      sessionId: sessionKey,
      process: child,
      pid: child.pid || null,
      startedAt: Date.now(),
      stdoutTail: [],
      stderrTail: [],
      stdout: '',
      terminalOutcome: null,
      cancelled: false,
      connectionMode: options.connection?.mode || 'auto',
    }

    log(`Spawned PID: ${child.pid}`)

    // The session key is the identity of the conversation for this tab, so the
    // renderer can be told immediately rather than waiting for the reply.
    this.emit('normalized', requestId, {
      type: 'session_init',
      sessionId: sessionKey,
      tools: [],
      model: options.model || '',
      mcpServers: [],
      skills: [],
      version: '',
    })

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      handle.stdout += chunk
      this._ringPush(handle.stdoutTail, chunk.substring(0, 300))
    })

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) this._ringPush(handle.stderrTail, trimmed)
      }
      log(`Stderr [${requestId}]: ${chunk.trim().substring(0, 500)}`)
    })

    child.on('close', (code, signal) => {
      log(`Process closed [${requestId}]: code=${code} signal=${signal}`)
      this._finish(requestId, handle, code)
      this._finishedRuns.set(requestId, handle)
      this.activeRuns.delete(requestId)
      this.emit('exit', requestId, code, signal, handle.sessionId)
      setTimeout(() => this._finishedRuns.delete(requestId), 5000)
    })

    child.on('error', (err) => {
      log(`Process error [${requestId}]: ${err.message}`)
      handle.terminalOutcome = 'error'
      this._finishedRuns.set(requestId, handle)
      this.activeRuns.delete(requestId)
      this.emit('error', requestId, err)
      setTimeout(() => this._finishedRuns.delete(requestId), 5000)
    })

    this.activeRuns.set(requestId, handle)
    return handle
  }

  /**
   * Turn the finished process into exactly one terminal event.
   *
   * A cancelled run is deliberately silent: the user already knows, and an
   * error card for their own Stop click is noise.
   */
  private _finish(requestId: string, handle: AgentRunHandle, code: number | null): void {
    if (handle.terminalOutcome) return

    if (handle.cancelled) {
      handle.terminalOutcome = 'error'
      return
    }

    const res = parseResponse(handle.stdout)

    if (!res) {
      handle.terminalOutcome = 'error'
      const stderrHint = handle.stderrTail.slice(-3).join(' ').trim()
      this.emit('normalized', requestId, {
        type: 'error',
        message: stderrHint
          ? `The agent CLI returned no readable reply (exit ${code}). ${stderrHint}`
          : `The agent CLI returned no readable reply (exit ${code}).`,
        isError: true,
        sessionId: handle.sessionId || undefined,
      })
      return
    }

    const meta = extractMeta(res)
    const payloads = extractPayloads(res)
    const text = payloadsToMarkdown(payloads)
    const ok = res.status === undefined || res.status === 'ok'
    // The CLI falls back to the embedded agent when the gateway will not serve
    // the run, and says so in the response rather than by failing.
    const usedEmbeddedFallback = meta.transport === 'embedded' || !!meta.fallbackFrom

    // The status bar has no other source for connectivity now that the TUI's
    // status line is gone. Only claim a state the response actually proves:
    // a served turn means reachable, a fallback means it was not, and anything
    // else (a bad model, a rejected argument) says nothing about the gateway
    // and must not be reported as a disconnect.
    if (handle.connectionMode !== 'local' && (ok || usedEmbeddedFallback)) {
      const state: GatewayConnectionState = usedEmbeddedFallback ? 'disconnected' : 'connected'
      this.emit('normalized', requestId, {
        type: 'gateway_state',
        state,
        detail: usedEmbeddedFallback
          ? `ran on the embedded agent instead${meta.fallbackReason ? ` (${meta.fallbackReason})` : ''}`
          : undefined,
      })
    }

    if (!ok) {
      handle.terminalOutcome = 'error'
      this.emit('normalized', requestId, {
        type: 'error',
        message: describeFailure(res),
        isError: true,
        sessionId: handle.sessionId || undefined,
      })
      return
    }

    // Completed, but with nothing to show. Reporting this as a finished turn
    // would leave the timeline silently unchanged, so say it plainly and give
    // the user the Retry affordance that comes with a failed run.
    if (!text) {
      handle.terminalOutcome = 'error'
      this.emit('normalized', requestId, {
        type: 'error',
        message: res.summary && res.summary !== 'completed'
          ? `The agent finished without sending a reply (${res.summary}).`
          : 'The agent finished without sending a reply.',
        isError: true,
        sessionId: handle.sessionId || undefined,
      })
      return
    }

    // The model that actually answered is only known once the reply lands, and
    // it is worth surfacing: a provider fallback can serve the turn on a
    // different model than the one requested. isWarmup keeps this from being
    // read as the start of a second turn — it updates session metadata without
    // touching run state. The companion fields repeat the empty values sent at
    // startup because this transport never learns tools/skills/MCP state; if it
    // ever does, they must be carried here too rather than blanked.
    const model = meta.agentMeta?.model
    if (model) {
      this.emit('normalized', requestId, {
        type: 'session_init',
        sessionId: handle.sessionId || '',
        tools: [],
        model,
        mcpServers: [],
        skills: [],
        version: '',
        isWarmup: true,
      })
    }

    if (text) {
      this.emit('normalized', requestId, { type: 'text_chunk', text })
    }

    handle.terminalOutcome = 'complete'
    this.emit('normalized', requestId, {
      type: 'task_complete',
      // text_chunk above already carried the reply; a non-empty result here
      // would make the store append the same text a second time.
      result: '',
      costUsd: 0,
      durationMs: meta.durationMs ?? Date.now() - handle.startedAt,
      numTurns: 1,
      usage: toUsageData(meta),
      sessionId: handle.sessionId || '',
    })
  }

  /**
   * Cancel a run. SIGTERM lets the CLI send `chat.abort` for an accepted
   * gateway run; SIGKILL is the backstop if it does not drain.
   */
  cancel(requestId: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false

    log(`Cancelling agent run ${requestId}`)
    handle.cancelled = true
    handle.process.kill('SIGTERM')

    setTimeout(() => {
      if (handle.process.exitCode === null) {
        log(`Force killing agent run ${requestId} (SIGTERM did not terminate)`)
        try { handle.process.kill('SIGKILL') } catch {}
      }
    }, 5000)

    return true
  }

  getEnrichedError(requestId: string, exitCode: number | null): EnrichedError {
    const handle = this.activeRuns.get(requestId) || this._finishedRuns.get(requestId)
    return {
      message: `Agent run failed with exit code ${exitCode}`,
      stderrTail: handle?.stderrTail.slice(-20) || [],
      stdoutTail: handle?.stdoutTail.slice(-20) || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
    }
  }

  isRunning(requestId: string): boolean {
    return this.activeRuns.has(requestId)
  }

  getHandle(requestId: string): AgentRunHandle | null {
    return this.activeRuns.get(requestId) || this._finishedRuns.get(requestId) || null
  }

  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys())
  }

  private _ringPush(buffer: string[], line: string): void {
    buffer.push(line)
    if (buffer.length > MAX_RING_LINES) buffer.shift()
  }
}
