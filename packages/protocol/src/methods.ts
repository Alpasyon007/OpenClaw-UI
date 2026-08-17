/**
 * The RPC surface this client uses.
 *
 * The gateway exposes ~237 core methods plus whatever plugins register at
 * runtime. Modelling all of them would be busywork that rots; what is here is
 * the set a companion operator client actually calls, with the parameter shapes
 * pinned because getting one wrong produces `INVALID_REQUEST` with no field
 * name attached.
 *
 * Result shapes are deliberately loose. Params are validated on the way out
 * because we control them; results are validated only where the client depends
 * on specific fields, so that a gateway which adds a field — or omits an
 * optional one — does not break a working client.
 */
import { z } from 'zod'
import type { Scope } from './connect'

// ─── Method names ───

export const M = {
  // read
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_GET: 'sessions.get',
  SESSIONS_RESOLVE: 'sessions.resolve',
  CHAT_HISTORY: 'chat.history',
  CHAT_MESSAGE_GET: 'chat.message.get',
  MODELS_LIST: 'models.list',
  AGENTS_LIST: 'agents.list',
  NODE_LIST: 'node.list',
  HEALTH: 'health',
  STATUS: 'status',

  // write
  CHAT_SEND: 'chat.send',
  CHAT_ABORT: 'chat.abort',
  SESSIONS_CREATE: 'sessions.create',
  SESSIONS_SEND: 'sessions.send',
  SESSIONS_STEER: 'sessions.steer',
  SESSIONS_ABORT: 'sessions.abort',
  SESSIONS_SUBSCRIBE: 'sessions.subscribe',
  SESSIONS_UNSUBSCRIBE: 'sessions.unsubscribe',
  SESSIONS_MESSAGES_SUBSCRIBE: 'sessions.messages.subscribe',
  SESSIONS_MESSAGES_UNSUBSCRIBE: 'sessions.messages.unsubscribe',

  // approvals
  EXEC_APPROVAL_LIST: 'exec.approval.list',
  EXEC_APPROVAL_GET: 'exec.approval.get',
  EXEC_APPROVAL_RESOLVE: 'exec.approval.resolve',
  EXEC_APPROVAL_WAIT_DECISION: 'exec.approval.waitDecision',
  PLUGIN_APPROVAL_LIST: 'plugin.approval.list',
  PLUGIN_APPROVAL_RESOLVE: 'plugin.approval.resolve',

  // device lifecycle
  DEVICE_TOKEN_ROTATE: 'device.token.rotate',
  DEVICE_TOKEN_REVOKE: 'device.token.revoke',

  // push
  PUSH_WEB_VAPID_PUBLIC_KEY: 'push.web.vapidPublicKey',
  PUSH_WEB_SUBSCRIBE: 'push.web.subscribe',
  PUSH_WEB_UNSUBSCRIBE: 'push.web.unsubscribe',
} as const

export type MethodName = (typeof M)[keyof typeof M]

/**
 * Scope required per method, for a pre-flight check.
 *
 * The gateway enforces this itself; the point of duplicating it is to fail in
 * the client with a message naming the missing scope, rather than surfacing a
 * generic `missing scope` from the wire that gives the user nothing to act on.
 */
export const METHOD_SCOPES: Partial<Record<MethodName, Scope>> = {
  [M.SESSIONS_LIST]: 'operator.read',
  [M.SESSIONS_GET]: 'operator.read',
  [M.SESSIONS_RESOLVE]: 'operator.read',
  [M.CHAT_HISTORY]: 'operator.read',
  [M.CHAT_MESSAGE_GET]: 'operator.read',
  [M.MODELS_LIST]: 'operator.read',
  [M.AGENTS_LIST]: 'operator.read',
  [M.NODE_LIST]: 'operator.read',
  [M.HEALTH]: 'operator.read',
  [M.STATUS]: 'operator.read',
  [M.SESSIONS_SUBSCRIBE]: 'operator.read',
  [M.SESSIONS_UNSUBSCRIBE]: 'operator.read',
  [M.SESSIONS_MESSAGES_SUBSCRIBE]: 'operator.read',
  [M.SESSIONS_MESSAGES_UNSUBSCRIBE]: 'operator.read',

  [M.CHAT_SEND]: 'operator.write',
  [M.CHAT_ABORT]: 'operator.write',
  [M.SESSIONS_CREATE]: 'operator.write',
  [M.SESSIONS_SEND]: 'operator.write',
  [M.SESSIONS_STEER]: 'operator.write',
  [M.SESSIONS_ABORT]: 'operator.write',
  [M.PUSH_WEB_VAPID_PUBLIC_KEY]: 'operator.write',
  [M.PUSH_WEB_SUBSCRIBE]: 'operator.write',
  [M.PUSH_WEB_UNSUBSCRIBE]: 'operator.write',

  [M.EXEC_APPROVAL_LIST]: 'operator.approvals',
  [M.EXEC_APPROVAL_GET]: 'operator.approvals',
  [M.EXEC_APPROVAL_RESOLVE]: 'operator.approvals',
  [M.EXEC_APPROVAL_WAIT_DECISION]: 'operator.approvals',
  [M.PLUGIN_APPROVAL_LIST]: 'operator.approvals',
  [M.PLUGIN_APPROVAL_RESOLVE]: 'operator.approvals',

  [M.DEVICE_TOKEN_ROTATE]: 'operator.pairing',
  [M.DEVICE_TOKEN_REVOKE]: 'operator.pairing',
}

/**
 * Whether a granted scope set satisfies a requirement.
 *
 * Two asymmetries the gateway applies and a naive `includes` would miss:
 * `operator.admin` satisfies every `operator.*`, and `operator.write` satisfies
 * `operator.read`.
 */
export function satisfiesScope(granted: readonly string[], required: Scope): boolean {
  if (granted.includes('operator.admin')) return true
  if (granted.includes(required)) return true
  if (required === 'operator.read' && granted.includes('operator.write')) return true
  return false
}

// ─── Params ───

export const SessionsListParamsSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})

/**
 * `chat.history` paging, which has two behaviours worth encoding rather than
 * documenting and hoping:
 *
 *  - Paging runs **backwards from newest**. `offset: 0` is the most recent page,
 *    not the oldest.
 *  - Omitting `offset` silently drops `totalMessages`, `hasMore` and
 *    `nextOffset` from the response — the gateway takes a different read path
 *    entirely. A client that leaves it out can never detect truncation.
 *
 * Hence `offset` defaults to 0 here instead of being left undefined.
 */
export const ChatHistoryParamsSchema = z.object({
  sessionKey: z.string().min(1).max(512),
  agentId: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().nonnegative().default(0),
  maxChars: z.number().int().min(1).max(500_000).optional(),
})

export type ChatHistoryParams = z.input<typeof ChatHistoryParamsSchema>

/**
 * `idempotencyKey` is **required**, not optional.
 *
 * It is also the primitive an offline outbox is built on: replaying the same key
 * returns `{status:"in_flight"}` while the run is going and `{status:"ok"}` once
 * it finished, so a client that retries after a dropped socket resumes tracking
 * the original run instead of starting a second one.
 */
export const ChatSendParamsSchema = z.object({
  sessionKey: z.string().min(1).max(512),
  idempotencyKey: z.string().min(1),
  message: z.string(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  thinking: z.unknown().optional(),
  fastMode: z.union([z.boolean(), z.literal('auto')]).optional(),
  attachments: z.array(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

export type ChatSendParams = z.infer<typeof ChatSendParamsSchema>

/** Non-blocking ack. The reply itself arrives as `chat` events. */
export const ChatSendResultSchema = z
  .object({
    runId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough()

export type ChatSendResult = z.infer<typeof ChatSendResultSchema>

export const ExecApprovalResolveParamsSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['allow-once', 'allow-always', 'deny']),
})

export const DeviceTokenParamsSchema = z.object({
  deviceId: z.string().min(1),
  role: z.enum(['operator', 'node']),
  scopes: z.array(z.string()).optional(),
})

// ─── Results we depend on ───

/**
 * One `chat.history` page.
 *
 * `hasMore`/`totalMessages`/`nextOffset` are optional in the type because the
 * gateway omits them when `offset` was not sent — see
 * {@link ChatHistoryParamsSchema}. Paginate by feeding `nextOffset` back rather
 * than computing it: the gateway derives it from an internal sequence number
 * when one is available, and arithmetic on `offset + received` drifts.
 */
export const ChatHistoryResultSchema = z
  .object({
    sessionKey: z.string().optional(),
    sessionId: z.string().optional(),
    messages: z.array(z.unknown()).default([]),
    offset: z.number().optional(),
    nextOffset: z.number().optional(),
    hasMore: z.boolean().optional(),
    totalMessages: z.number().optional(),
  })
  .passthrough()

export type ChatHistoryResult = z.infer<typeof ChatHistoryResultSchema>

export const ExecApprovalListResultSchema = z
  .object({
    approvals: z.array(z.unknown()).default([]),
  })
  .passthrough()
