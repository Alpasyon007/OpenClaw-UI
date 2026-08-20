/**
 * Sessions that live on the gateway, rather than on this machine.
 *
 * `src/main/sessions.ts` walks local JSONL transcripts. That can never see a
 * gateway session: with `gateway.mode: "remote"` the CLI's own
 * `openclaw sessions list` still reports the *local* store (verified — it
 * answered with a local path and one session while the gateway held twenty).
 * Only `gateway call` crosses the wire, so this module is built on two RPCs:
 *
 *   sessions.list  { limit, offset }                  -> the gateway's store
 *   chat.history   { sessionKey, limit, offset: 0 }    -> one session's turns
 *
 * The RPC is *injected* rather than imported so credentials stay in the
 * sidecar and every degradation branch is unit-testable without spawning a
 * process.
 *
 * Nothing here throws. Both readers always answer a fully-populated result of
 * the declared shape, because the picker renders them directly and a gateway
 * that is down must never be able to disturb the local list.
 */
import type {
  GatewaySessionMeta,
  GatewaySessionListResult,
  GatewaySessionHistoryResult,
  GatewaySessionsUnavailableReason,
  SessionLoadMessage,
} from '../shared/types'
import { log as _log } from './logger'

function log(msg: string): void {
  _log('gw-sessions', msg)
}

/** Outcome of one `gateway call`, with the gateway's own error text preserved. */
export interface GatewayRpcResult {
  /** Parsed JSON body. Null when nothing usable came back. */
  body: unknown
  /** The gateway's error text, {@link NO_CREDENTIAL}, or null on success. */
  errorMessage: string | null
}

export type GatewayCall = (
  method: string,
  params: unknown,
  timeoutMs: number,
) => Promise<GatewayRpcResult>

/** Sentinel: no credential resolved, so no call was attempted. */
export const NO_CREDENTIAL = '__no_credential__'

export const GATEWAY_SESSIONS_PROBE_KEY = 'gateway-sessions'
/** A session list changes on the order of a conversation, not a poll. */
export const GATEWAY_SESSIONS_TTL_MS = 60_000
/**
 * Failures get a much shorter window — long enough to collapse a burst of
 * popover opens, short enough that a gateway coming back is noticed. Raising
 * this to match the success TTL would pin 'unreachable' across a recovery.
 */
export const GATEWAY_SESSIONS_FAILURE_TTL_MS = 10_000

export const GATEWAY_HISTORY_DEFAULT_LIMIT = 200
/** Rows offered in the picker. */
export const MAX_GATEWAY_SESSIONS = 40

const LIST_TIMEOUT_MS = 20_000
const HISTORY_TIMEOUT_MS = 30_000
/** A single observed transcript was 125KB; one turn should not be able to
 *  dominate the renderer. */
const MAX_MESSAGE_CHARS = 20_000

// ─── Mapping ───

/**
 * Epoch ms from a number, an ISO string, or anything else.
 *
 * Never NaN — a NaN in a comparator makes V8's sort order-dependent, so an
 * unparseable timestamp becomes 0 and sorts last rather than shuffling the
 * list.
 */
export function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** One `sessions.list` row, or null when it carries no key to resume by. */
export function mapGatewaySession(raw: unknown): GatewaySessionMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  // The one hard requirement, mirroring the picker's own id filter: a row with
  // no key can be neither rendered nor resumed. An id-less row reaching render
  // is what blanked the whole app once already.
  const sessionKey = typeof r.key === 'string' ? r.key.trim() : ''
  if (!sessionKey) return null

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const ts =
    toEpochMs(r.lastActivityAt) ||
    toEpochMs(r.updatedAt) ||
    toEpochMs(r.endedAt) ||
    toEpochMs(r.startedAt)

  return {
    sessionKey,
    sessionId: str(r.sessionId),
    displayName: str(r.displayName),
    kind: str(r.kind),
    lastTimestamp: ts ? new Date(ts).toISOString() : null,
    model: str(r.model),
    totalTokens: num(r.totalTokens),
    status: str(r.status),
    // Strict `=== true`: the string 'false' and the number 0 are not flags.
    hasActiveRun: r.hasActiveRun === true,
    archived: r.archived === true,
    pinned: r.pinned === true,
    unread: r.unread === true,
  }
}

/** Most recently active first; undated rows last; ties broken by key. */
export function sortGatewaySessions(a: GatewaySessionMeta, b: GatewaySessionMeta): number {
  const at = toEpochMs(a.lastTimestamp)
  const bt = toEpochMs(b.lastTimestamp)
  if (at !== bt) return bt - at
  return a.sessionKey.localeCompare(b.sessionKey)
}

/**
 * `chat.history` messages into the shape the renderer already hydrates.
 *
 * Only user and assistant prose plus tool *names* are carried across, which is
 * exactly what {@link readLocalTranscript} produces for a local transcript, so
 * a resumed gateway tab and a resumed local tab render identically.
 *
 * Tool *results* are deliberately dropped. They are the bulk of a transcript's
 * bytes, and they are untrusted third-party data — observed gateway transcripts
 * contained web-fetched material the gateway itself had wrapped in
 * EXTERNAL_UNTRUSTED_CONTENT markers. None of it is instructions to anyone, and
 * the safest way to keep it that way is not to carry it.
 */
export function mapGatewayMessages(
  raw: unknown,
  limit: number,
): { messages: SessionLoadMessage[]; truncated: boolean; totalMessages: number | null } {
  const body = (raw ?? {}) as Record<string, unknown>
  const wire = Array.isArray(body.messages) ? (body.messages as unknown[]) : []
  const totalMessages =
    typeof body.totalMessages === 'number' && Number.isFinite(body.totalMessages)
      ? body.totalMessages
      : null

  // The page is chronological, but only sort when every row can be ordered —
  // a partial sort key would reshuffle rather than refine.
  const seqOf = (m: unknown): number | null => {
    const meta = (m as Record<string, unknown> | null)?.__openclaw as
      | Record<string, unknown>
      | undefined
    const seq = meta?.seq
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
  }
  const ordered = wire.every((m) => seqOf(m) !== null)
    ? [...wire].sort((a, b) => (seqOf(a) as number) - (seqOf(b) as number))
    : wire

  const messages: SessionLoadMessage[] = []
  for (const entry of ordered) {
    if (!entry || typeof entry !== 'object') continue
    const m = entry as Record<string, unknown>
    const role = typeof m.role === 'string' ? m.role : ''
    if (role !== 'user' && role !== 'assistant') continue
    const timestamp = toEpochMs(m.timestamp)
    const content = m.content

    if (typeof content === 'string') {
      const text = content.trim()
      if (text) messages.push({ role, content: text.slice(0, MAX_MESSAGE_CHARS), timestamp })
      continue
    }
    if (!Array.isArray(content)) continue

    const parts = content as Array<Record<string, unknown>>
    const text = parts
      .filter((p) => p?.type === 'text')
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n\n')
      .trim()
    if (text) messages.push({ role, content: text.slice(0, MAX_MESSAGE_CHARS), timestamp })

    for (const p of parts) {
      if (p?.type === 'toolCall' && typeof p.name === 'string' && p.name) {
        messages.push({ role: 'tool', content: '', toolName: p.name, timestamp })
      }
    }
  }

  // `hasMore` describes the wire's paging; a session longer than we asked for
  // is truncated whether or not the gateway volunteered that field.
  const truncated =
    body.hasMore === true || (totalMessages !== null && totalMessages > limit)

  return { messages, truncated, totalMessages }
}

// ─── Degradation ───

/**
 * Classify a failed call.
 *
 * An unknown method is not an error worth showing: it means this gateway
 * predates `sessions.list`, and a capability the runtime does not have is a
 * normal state — the same judgement `fetchGatewaySkills` makes about a CLI
 * without `skills list`. The picker hides the group rather than badging it.
 */
export function classifyGatewayFailure(
  errorMessage: string,
): { reason: GatewaySessionsUnavailableReason; error: string | null } {
  if (errorMessage === NO_CREDENTIAL) {
    return { reason: 'no-credential', error: 'No gateway credential is available to this app.' }
  }
  if (/unknown method|method not found|not implemented|unsupported method/i.test(errorMessage)) {
    return { reason: 'unsupported', error: null }
  }
  return { reason: 'unreachable', error: 'Could not reach the gateway.' }
}

function unavailable(
  errorMessage: string,
  fetchedAt: number,
): GatewaySessionListResult {
  const { reason, error } = classifyGatewayFailure(errorMessage)
  return { ok: false, available: false, sessions: [], reason, error, fetchedAt }
}

// ─── Readers ───

/**
 * The gateway's session store, most recently active first.
 *
 * Archived sessions are filtered out; everything else is offered. `kind` is
 * uniformly 'direct' on observed gateways — including cron and node sessions —
 * so filtering on it would be a no-op dressed up as a filter. The key prefix
 * and `displayName` are what actually distinguish them, and both are carried
 * through for the picker to label with.
 */
export async function readGatewaySessions(
  call: GatewayCall,
  now: number,
): Promise<GatewaySessionListResult> {
  let res: GatewayRpcResult
  try {
    res = await call('sessions.list', { limit: MAX_GATEWAY_SESSIONS, offset: 0 }, LIST_TIMEOUT_MS)
  } catch (err) {
    // A thrown call is still just an unreachable gateway to the reader.
    log(`sessions.list threw: ${String(err)}`)
    return unavailable(String(err), now)
  }

  if (res.errorMessage !== null) {
    log(`sessions.list failed: ${res.errorMessage.slice(0, 200)}`)
    return unavailable(res.errorMessage, now)
  }

  const body = (res.body ?? {}) as Record<string, unknown>
  const rows = Array.isArray(body.sessions) ? (body.sessions as unknown[]) : []
  const sessions = rows
    .map(mapGatewaySession)
    .filter((s): s is GatewaySessionMeta => s !== null && !s.archived)
    .sort(sortGatewaySessions)
    .slice(0, MAX_GATEWAY_SESSIONS)

  log(`sessions.list: ${sessions.length} of ${rows.length} row(s) usable`)
  return { ok: true, available: true, sessions, reason: null, error: null, fetchedAt: now }
}

/**
 * One gateway session's turns.
 *
 * `offset: 0` is mandatory and means the *newest* page — the wire pages
 * newest-first. Sending `limit` alone silently omits `totalMessages` and
 * `hasMore`, so truncation could never be reported.
 */
export async function readGatewaySessionHistory(
  call: GatewayCall,
  sessionKey: string,
  limit: number = GATEWAY_HISTORY_DEFAULT_LIMIT,
): Promise<GatewaySessionHistoryResult> {
  const key = String(sessionKey ?? '').trim()
  const empty = (error: string | null): GatewaySessionHistoryResult => ({
    ok: error === null,
    sessionKey: key,
    messages: [],
    truncated: false,
    totalMessages: null,
    error,
  })
  if (!key) return empty('No session key was given.')

  let res: GatewayRpcResult
  try {
    res = await call('chat.history', { sessionKey: key, limit, offset: 0 }, HISTORY_TIMEOUT_MS)
  } catch (err) {
    log(`chat.history threw: ${String(err)}`)
    return empty('Could not reach the gateway.')
  }

  if (res.errorMessage !== null) {
    log(`chat.history failed for ${key}: ${res.errorMessage.slice(0, 200)}`)
    const { reason } = classifyGatewayFailure(res.errorMessage)
    return empty(
      reason === 'no-credential'
        ? 'No gateway credential is available to this app.'
        : 'Could not load this session from the gateway.',
    )
  }

  const { messages, truncated, totalMessages } = mapGatewayMessages(res.body, limit)
  log(`chat.history ${key}: ${messages.length} message(s), truncated=${truncated}`)
  return { ok: true, sessionKey: key, messages, truncated, totalMessages, error: null }
}
