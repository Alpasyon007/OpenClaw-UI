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
import { ChatAttachmentSchema } from './attachments'
import type { GatewayRequestErrorLike } from './frames-errors'

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
  COMMANDS_LIST: 'commands.list',
  SKILLS_LIST: 'skills.list',

  // admin — see ADMIN_SCOPES; a companion asks for these only on request
  CONFIG_GET: 'config.get',
  CONFIG_SET: 'config.set',
  NODE_STATUS: 'node.status',
  SKILLS_INSTALL: 'skills.install',
  SKILLS_UNINSTALL: 'skills.uninstall',
  SKILLS_CREATE: 'skills.create',

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
  [M.COMMANDS_LIST]: 'operator.read',
  [M.SKILLS_LIST]: 'operator.read',

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

  // Mutating the runtime's own configuration and inventory. `operator.admin`
  // is the only scope that satisfies these, and a device paired at the
  // companion default has none of them — the pre-flight check in the client is
  // what turns that into "re-pair to request admin" rather than a bare
  // `missing scope` from the wire.
  [M.CONFIG_GET]: 'operator.admin',
  [M.CONFIG_SET]: 'operator.admin',
  [M.NODE_STATUS]: 'operator.admin',
  [M.SKILLS_INSTALL]: 'operator.admin',
  [M.SKILLS_UNINSTALL]: 'operator.admin',
  [M.SKILLS_CREATE]: 'operator.admin',
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
  attachments: z.array(ChatAttachmentSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Per-send model override.
   *
   * Not universally accepted: older gateway builds validate `chat.send` params
   * strictly and answer `INVALID_REQUEST` for a field they do not know, which
   * would make every send fail the moment a user picks a model. Send it only
   * when the user actually chose one, and be prepared to retry without it —
   * {@link isRejectedParamError} is the check for that path.
   */
  model: z.string().optional(),
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

/**
 * Did the gateway reject a *parameter* rather than fail the operation?
 *
 * The one place this matters is the optional `model` on `chat.send`. A gateway
 * that does not know the field answers `INVALID_REQUEST`, and without this
 * check the user's message is simply lost — they picked a model and sending
 * stopped working, with nothing on screen connecting the two. Detecting it lets
 * the caller retry once without the field and tell the user their model choice
 * did not take, which is a far better outcome than a failed send.
 *
 * Kept narrow on purpose: only `INVALID_REQUEST`, and only when the message
 * actually names a field. A broad match here would silently retry real
 * validation failures and hide them.
 */
export function isRejectedParamError(error: unknown, field: string): boolean {
  const err = error as GatewayRequestErrorLike | null
  if (!err || typeof err !== 'object') return false
  if (err.code !== 'INVALID_REQUEST') return false
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : ''
  if (!message) return false
  const name = field.toLowerCase()
  return (
    message.includes(name) &&
    /\bunknown\b|\bunrecognis|\bunrecogniz|\bunexpected\b|\bnot allowed\b|\bnot permitted\b|\badditional\b/.test(
      message,
    )
  )
}

// ─── Catalogue and admin params ───

export const SkillsListParamsSchema = z.object({
  /** Include skills that are present but not currently runnable. */
  includeDisabled: z.boolean().optional(),
})

export const SkillsInstallParamsSchema = z.object({
  /** Directory name under the runtime's managed skills dir. */
  name: z.string().min(1).max(128),
  /** Raw `SKILL.md`. The gateway writes it; it is never executed here. */
  content: z.string().min(1),
  /** Where it came from, for the runtime's own bookkeeping. */
  source: z.string().optional(),
  /** Replace an existing skill of the same name rather than failing. */
  overwrite: z.boolean().optional(),
})

export const SkillsUninstallParamsSchema = z.object({
  name: z.string().min(1).max(128),
})

/**
 * One entry from `skills.list`.
 *
 * Mirrors the `openclaw skills list --json` payload the desktop already parses,
 * so a skill reads the same on both surfaces. Everything optional: the runtime
 * reports different subsets for bundled, extra and workspace skills.
 */
export const GatewaySkillSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    emoji: z.string().optional(),
    source: z.string().optional(),
    disabled: z.boolean().optional(),
    eligible: z.boolean().optional(),
    homepage: z.string().optional(),
    missing: z
      .object({
        bins: z.array(z.string()).optional(),
        anyBins: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        config: z.array(z.string()).optional(),
        os: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type GatewaySkill = z.infer<typeof GatewaySkillSchema>

export const SkillsListResultSchema = z
  .object({
    managedSkillsDir: z.string().optional(),
    skills: z.array(GatewaySkillSchema).default([]),
  })
  .passthrough()

/**
 * One entry from `commands.list`.
 *
 * The gateway exposes slash commands the runtime knows about, including ones
 * registered by plugins. A client that hardcodes its own list shows the user
 * commands their runtime does not have and hides the ones it does.
 */
export const GatewayCommandSchema = z
  .object({
    name: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough()

export type GatewayCommand = z.infer<typeof GatewayCommandSchema>

export const CommandsListResultSchema = z
  .object({ commands: z.array(GatewayCommandSchema).default([]) })
  .passthrough()

/**
 * A node the gateway can route work to.
 *
 * Loose by design — a node reports fields specific to its host, and the panel
 * renders whatever identifying detail it finds rather than requiring a shape.
 */
export const GatewayNodeSchema = z
  .object({
    id: z.string().optional(),
    nodeId: z.string().optional(),
    name: z.string().optional(),
    host: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
    online: z.boolean().optional(),
    status: z.string().optional(),
    lastSeenAt: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()

export type GatewayNode = z.infer<typeof GatewayNodeSchema>

export const NodeListResultSchema = z
  .object({ nodes: z.array(GatewayNodeSchema).default([]) })
  .passthrough()

/**
 * `health` and `status` payloads.
 *
 * Both are rendered as key/value rows rather than parsed into a fixed shape:
 * the gateway adds counters freely, and a schema that names them would show a
 * shrinking subset of the truth as the server gains fields.
 */
export const HealthResultSchema = z.record(z.unknown())

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
