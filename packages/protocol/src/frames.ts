/**
 * The three frame shapes that make up the OpenClaw gateway wire protocol.
 *
 * This is deliberately *not* JSON-RPC 2.0, and assuming it is will waste a day:
 * there is no `jsonrpc` field, responses carry `ok` rather than distinguishing
 * `result` from `error` by presence, and server-pushed events are a first-class
 * third shape rather than a notification with a null id.
 *
 *   req    { type:"req",   id, method, params? }
 *   res    { type:"res",   id, ok, payload?, error? }
 *   event  { type:"event", event, payload?, seq?, stateVersion? }
 *
 * Every inbound frame is parsed rather than cast. The gateway is a third-party
 * binary on the other end of a socket we do not control, and the failure mode
 * for a cast is a `TypeError` three layers into the reducer with no indication
 * of which field was missing.
 */
import { z } from 'zod'

/**
 * The protocol revision this client speaks.
 *
 * Operator sessions must be current — only `role: "node"` clients get an N-1
 * compatibility window, so there is no point declaring a range wider than one
 * version here.
 */
export const PROTOCOL_VERSION = 4

/**
 * Closed set. Anything outside it is a gateway newer than this client, which is
 * why {@link ErrorShapeSchema} keeps `code` as a plain string rather than an
 * enum — rejecting an unrecognised code would turn "new error type" into
 * "connection is broken".
 */
export const ERROR_CODES = [
  'NOT_LINKED',
  'NOT_PAIRED',
  'AGENT_TIMEOUT',
  'INVALID_REQUEST',
  'APPROVAL_NOT_FOUND',
  'UNAVAILABLE',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * `details` is intentionally loose. It carries the discriminators that actually
 * drive client behaviour — `code`, `reason`, `recommendedNextStep` — but the
 * gateway adds fields to it freely and a strict shape here would reject frames
 * that are otherwise perfectly usable.
 */
export const ErrorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
})

export type ErrorShape = z.infer<typeof ErrorShapeSchema>

export const RequestFrameSchema = z.object({
  type: z.literal('req'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const ResponseFrameSchema = z.object({
  type: z.literal('res'),
  id: z.string().min(1),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: ErrorShapeSchema.optional(),
})

/**
 * `seq` is per-connection and monotonic **on your own socket only**.
 *
 * Different clients hold different scopes, so the gateway filters each one's
 * event stream differently and then numbers what survives. Comparing a `seq`
 * from one client against another's is meaningless, and using it as a global
 * ordering key across a reconnect is a bug — the counter restarts.
 */
export const EventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  payload: z.unknown().optional(),
  seq: z.number().optional(),
  /**
   * A map of per-stream counters, e.g. `{ presence: 1091, health: 37631 }` —
   * **not** a single version number.
   *
   * Typed as unknown deliberately. This client does not read it, and an earlier
   * revision guessed `z.number()`, which made every `health` event fail to parse
   * and be dropped as unreadable. Constraining a field nothing consumes buys no
   * safety and costs real events.
   */
  stateVersion: z.unknown().optional(),
})

export type RequestFrame = z.infer<typeof RequestFrameSchema>
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>
export type EventFrame = z.infer<typeof EventFrameSchema>

/**
 * Any frame the server can send us. `req` is included because the node role
 * receives server-initiated requests (`node.invoke.request`); an operator client
 * should never see one, but parsing it as a known shape and ignoring it beats
 * failing to parse and treating the socket as corrupt.
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
  ResponseFrameSchema,
  EventFrameSchema,
  RequestFrameSchema,
])

export type ServerFrame = z.infer<typeof ServerFrameSchema>

/**
 * Parse one inbound text frame.
 *
 * Never throws. A frame we cannot understand is a diagnostic, not a fatal
 * condition — the socket carries broadcast traffic for capabilities this client
 * does not use, and one unparseable event must not tear down a live session.
 */
export function parseServerFrame(
  raw: string,
): { ok: true; frame: ServerFrame } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'frame was not valid JSON' }
  }

  const parsed = ServerFrameSchema.safeParse(json)
  if (!parsed.success) {
    // Report the shape, never the contents: frames carry transcript text and
    // approval payloads, and this string ends up in logs.
    const type =
      json && typeof json === 'object' && 'type' in json
        ? String((json as Record<string, unknown>).type)
        : 'absent'
    return { ok: false, error: `frame did not match any known shape (type=${type})` }
  }

  return { ok: true, frame: parsed.data }
}

// ─── Operational limits ───
//
// Defaults only. The server sends its live values in `hello-ok.policy`, and the
// client must prefer those — these exist so a client has something sane to
// enforce before the handshake completes, and for tests.

/** Inbound cap before `connect` succeeds. */
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024
/** Inbound cap once authenticated. */
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024
/**
 * Outbound buffer the server tolerates before it either drops the frame or
 * closes with 1008 "slow consumer". A client that stops draining its socket
 * while a long run streams is the realistic way to hit this.
 */
export const MAX_BUFFERED_BYTES = 50 * 1024 * 1024
/**
 * Server heartbeat cadence. Reference clients close at twice this silence.
 *
 * Verified against `TICK_INTERVAL_MS = 3e4` in the gateway's own
 * `server-constants` module. Setting this too low is not a harmless
 * conservatism — it makes the client hang up on a perfectly healthy idle
 * connection, which then looks like a flaky network.
 */
export const DEFAULT_TICK_INTERVAL_MS = 30_000

/** WebSocket close code the gateway uses for a consumer that fell behind. */
export const CLOSE_SLOW_CONSUMER = 1008
/** Close code reference clients use when the server has gone quiet. */
export const CLOSE_TICK_TIMEOUT = 4000
