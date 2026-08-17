/**
 * Transcript state — pure, so the hard parts can be tested without a socket.
 *
 * The desktop renderer learned several of these rules the expensive way, and
 * they are reproduced here rather than rediscovered:
 *
 *  - **Never mutate a message in place.** Rows are memoised on object identity,
 *    so an in-place append renders nothing at all. Every update replaces the
 *    object.
 *  - **`replace: true` inverts what `deltaText` means.** It is the full
 *    replacement for the run's text so far, not something to append. It only
 *    fires when the model rewrites what it already emitted, so appending passes
 *    every happy-path test and corrupts real transcripts.
 *  - **Live events are delivery state; `chat.history` is the durable truth.**
 *    On reconnect the history page wins, and only an optimistic tail survives.
 */
import type { ChatEvent } from '@openclaw/protocol'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'
export type MessageStatus = 'streaming' | 'complete' | 'error'

export interface TranscriptMessage {
  id: string
  role: MessageRole
  content: string
  status: MessageStatus
  timestamp: number
  /** Present on tool rows. */
  toolName?: string
  /** The run this row belongs to, when it came from a live event. */
  runId?: string
  /** Set on an error row so the UI can distinguish a refusal from a crash. */
  errorKind?: string
  /** True while a locally-composed message has not yet been acknowledged. */
  pending?: boolean
}

export interface TranscriptState {
  messages: TranscriptMessage[]
  /** The run currently streaming, if any. */
  activeRunId: string | null
  /** Cumulative token usage reported for the active run. */
  usage: Record<string, number> | null
}

export function emptyTranscript(): TranscriptState {
  return { messages: [], activeRunId: null, usage: null }
}

/** Ids are derived, not random, so the same event always yields the same row. */
const assistantRowId = (runId: string): string => `run:${runId}`

/**
 * Fold one live `chat` event into the transcript.
 *
 * Returns the same object when nothing changed, so a store can skip a render.
 */
export function applyChatEvent(state: TranscriptState, event: ChatEvent): TranscriptState {
  const rowId = assistantRowId(event.runId)
  const index = state.messages.findIndex((m) => m.id === rowId)
  const existing = index >= 0 ? state.messages[index] : null

  if (event.state === 'delta') {
    const next = event.replace
      ? event.deltaText
      : (existing?.content ?? '') + event.deltaText

    // A delta that changes nothing must not churn the list — this fires often
    // enough during streaming for the wasted renders to be visible.
    if (existing && existing.content === next && existing.status === 'streaming') {
      return state
    }

    const row: TranscriptMessage = {
      id: rowId,
      role: 'assistant',
      content: next,
      status: 'streaming',
      timestamp: existing?.timestamp ?? Date.now(),
      runId: event.runId,
    }

    return {
      ...state,
      activeRunId: event.runId,
      usage: readUsage(event) ?? state.usage,
      messages: replaceOrAppend(state.messages, index, row),
    }
  }

  // Terminal states.
  const status: MessageStatus = event.state === 'final' ? 'complete' : 'error'
  const errorMessage =
    event.state === 'aborted' || event.state === 'error' ? (event.errorMessage ?? '') : ''

  const content =
    existing?.content && existing.content.length > 0
      ? existing.content
      : errorMessage || fallbackText(event)

  const row: TranscriptMessage = {
    id: rowId,
    role: 'assistant',
    content,
    status,
    timestamp: existing?.timestamp ?? Date.now(),
    runId: event.runId,
    ...(event.state === 'error' && event.errorKind ? { errorKind: event.errorKind } : {}),
  }

  return {
    ...state,
    // Only clear the active run if this event is about it. A late terminal
    // event from a previous run must not stop the UI showing the current one.
    activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
    usage: readUsage(event) ?? state.usage,
    messages: replaceOrAppend(state.messages, index, row),
  }
}

function replaceOrAppend(
  messages: TranscriptMessage[],
  index: number,
  row: TranscriptMessage,
): TranscriptMessage[] {
  if (index < 0) return [...messages, row]
  const next = [...messages]
  next[index] = row
  return next
}

function readUsage(event: ChatEvent): Record<string, number> | null {
  const usage = 'usage' in event ? event.usage : undefined
  if (!usage || typeof usage !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * What to show when a run ends having produced no text.
 *
 * An empty assistant bubble reads as a bug. Naming the outcome is honest and
 * tells the user whether to retry.
 */
function fallbackText(event: ChatEvent): string {
  switch (event.state) {
    case 'aborted':
      return '(run cancelled)'
    case 'error':
      return '(the run failed)'
    default:
      return ''
  }
}

// ─── User messages and the outbox ───

/**
 * Add a locally-composed message immediately.
 *
 * Marked `pending` until the send is acknowledged. Showing it straight away is
 * what makes the app feel responsive; marking it is what stops a failed send
 * looking like a delivered one.
 */
export function addPendingUserMessage(
  state: TranscriptState,
  id: string,
  text: string,
  now: number,
): TranscriptState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { id, role: 'user', content: text, status: 'complete', timestamp: now, pending: true },
    ],
  }
}

export function settlePendingMessage(
  state: TranscriptState,
  id: string,
  outcome: 'sent' | 'failed',
): TranscriptState {
  const index = state.messages.findIndex((m) => m.id === id)
  if (index < 0) return state
  const row = state.messages[index]
  const next = [...state.messages]
  next[index] =
    outcome === 'sent'
      ? { ...row, pending: false }
      : { ...row, pending: false, status: 'error' }
  return { ...state, messages: next }
}

// ─── History ───

/**
 * Replace the transcript with a `chat.history` page.
 *
 * History is authoritative, but a run that is still streaming has not been
 * written to it yet — so a live row for the active run is carried across.
 * Dropping it would blank the reply mid-sentence on every reconnect.
 */
export function applyHistory(
  state: TranscriptState,
  rows: readonly unknown[],
): TranscriptState {
  const messages: TranscriptMessage[] = []

  rows.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    const role = typeof m.role === 'string' ? m.role : ''
    if (role !== 'user' && role !== 'assistant') return

    const content = extractText(m.content)
    if (!content) return

    messages.push({
      id: typeof m.id === 'string' ? m.id : `hist:${i}`,
      role,
      content,
      status: 'complete',
      timestamp: toEpoch(m.timestamp),
    })
  })

  const live = state.activeRunId
    ? state.messages.filter((m) => m.runId === state.activeRunId && m.status === 'streaming')
    : []

  return { ...state, messages: [...messages, ...live] }
}

/** Content arrives as a string or as an array of typed parts. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => p.type === 'text')
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('\n\n')
    .trim()
}

function toEpoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
