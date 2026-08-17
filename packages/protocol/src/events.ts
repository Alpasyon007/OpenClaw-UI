/**
 * Server-pushed events.
 *
 * Most of these are **broadcast, not subscribed**. A client holding
 * `operator.read` starts receiving `chat` events for every run on the gateway
 * the moment the handshake completes — there is no "subscribe to this session"
 * step for the basic transcript stream, and waiting for one is a common way to
 * end up with an app that connects successfully and then appears dead.
 *
 * Which events reach a client is decided purely by its granted scopes:
 *
 *   operator.read       chat, agent, session.*, sessions.changed, cron, task, talk.event
 *   operator.approvals  exec.approval.*, plugin.approval.*
 *   operator.pairing    device.pair.*, node.pair.*
 *   operator.admin      terminal.*  (and implicitly everything above)
 *   (none)              health, heartbeat, presence, tick, shutdown, update.available
 */
import { z } from 'zod'

// ─── Event names ───

export const EVENT_CHAT = 'chat'
export const EVENT_TICK = 'tick'
export const EVENT_SESSIONS_CHANGED = 'sessions.changed'
export const EVENT_EXEC_APPROVAL_REQUESTED = 'exec.approval.requested'
export const EVENT_EXEC_APPROVAL_RESOLVED = 'exec.approval.resolved'
export const EVENT_PLUGIN_APPROVAL_REQUESTED = 'plugin.approval.requested'
export const EVENT_PLUGIN_APPROVAL_RESOLVED = 'plugin.approval.resolved'

// ─── chat ───

export const CHAT_ERROR_KINDS = [
  'refusal',
  'timeout',
  'rate_limit',
  'context_length',
  'unknown',
] as const

export type ChatErrorKind = (typeof CHAT_ERROR_KINDS)[number]

/**
 * Token usage. Every field optional — providers report different subsets and a
 * missing counter is normal, not an error.
 */
export const UsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .passthrough()

const ChatEventBase = {
  runId: z.string(),
  sessionKey: z.string(),
  agentId: z.string().optional(),
  spawnedBy: z.string().optional(),
  seq: z.number().optional(),
}

/**
 * `deltaText` is the incremental text; `message` is the **cumulative** assistant
 * snapshot at this point in the run.
 *
 * `replace: true` inverts the meaning of `deltaText` — it becomes the full
 * replacement for everything streamed so far in this run rather than something
 * to append. The gateway sends it when the model rewrites text it already
 * emitted (a non-prefix revision). Appending it instead duplicates the entire
 * response, and because it only fires on revisions it will pass every happy-path
 * test and corrupt real transcripts.
 */
export const ChatDeltaSchema = z.object({
  ...ChatEventBase,
  state: z.literal('delta'),
  deltaText: z.string().default(''),
  message: z.unknown().optional(),
  replace: z.boolean().optional(),
  usage: UsageSchema.optional(),
})

export const ChatFinalSchema = z.object({
  ...ChatEventBase,
  state: z.literal('final'),
  message: z.unknown().optional(),
  usage: UsageSchema.optional(),
  stopReason: z.string().optional(),
})

export const ChatAbortedSchema = z.object({
  ...ChatEventBase,
  state: z.literal('aborted'),
  message: z.unknown().optional(),
  errorMessage: z.string().optional(),
  stopReason: z.string().optional(),
})

export const ChatErrorSchema = z.object({
  ...ChatEventBase,
  state: z.literal('error'),
  message: z.unknown().optional(),
  errorMessage: z.string().optional(),
  errorKind: z.string().optional(),
  usage: UsageSchema.optional(),
  stopReason: z.string().optional(),
})

export const ChatEventSchema = z.discriminatedUnion('state', [
  ChatDeltaSchema,
  ChatFinalSchema,
  ChatAbortedSchema,
  ChatErrorSchema,
])

export type ChatEvent = z.infer<typeof ChatEventSchema>
export type ChatDeltaEvent = z.infer<typeof ChatDeltaSchema>

/** Terminal states. A run that reaches one of these will send nothing further. */
export function isTerminalChatState(event: ChatEvent): boolean {
  return event.state !== 'delta'
}

// ─── exec approvals ───

/**
 * The three answers a reviewer can give.
 *
 * `allow-always` records durable trust for the command, but the request may
 * list it in `unavailableDecisions` — under `ask: "always"` the host keeps
 * prompting regardless of stored trust, so offering the button would promise
 * something the gateway will not honour.
 */
export const APPROVAL_DECISIONS = ['allow-once', 'allow-always', 'deny'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

/**
 * A span within the command string, for highlighting.
 *
 * Rendering these is what lets a reviewer see *why* a command is flagged rather
 * than reading a wall of shell text on a phone screen at arm's length.
 */
export const CommandSpanSchema = z
  .object({
    start: z.number().optional(),
    end: z.number().optional(),
    kind: z.string().optional(),
  })
  .passthrough()

/**
 * The canonical plan for a node-hosted run.
 *
 * The gateway binds this to the approval: if `command`, `rawCommand`, `cwd`,
 * `agentId` or `sessionKey` differ between the request and the eventual
 * forwarded run, it rejects the run outright. That is a deliberate TOCTOU
 * defence, and the practical consequence for a client is that the request must
 * be echoed back **verbatim** — never normalised, re-quoted or rebuilt from
 * parsed parts.
 */
export const SystemRunPlanSchema = z
  .object({
    argv: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    commandText: z.string().optional(),
    commandPreview: z.string().optional(),
    agentId: z.string().optional(),
    sessionKey: z.string().optional(),
    mutableFileOperand: z
      .object({
        argvIndex: z.number().optional(),
        path: z.string().optional(),
        sha256: z.string().optional(),
      })
      .optional(),
  })
  .passthrough()

export const ExecApprovalRequestSchema = z
  .object({
    id: z.string().optional(),
    command: z.string().optional(),
    commandArgv: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    nodeId: z.string().optional(),
    host: z.string().optional(),
    security: z.string().optional(),
    ask: z.string().optional(),
    warningText: z.string().optional(),
    resolvedPath: z.string().optional(),
    agentId: z.string().optional(),
    sessionKey: z.string().optional(),
    commandSpans: z.array(CommandSpanSchema).optional(),
    unavailableDecisions: z.array(z.string()).optional(),
    timeoutMs: z.number().optional(),
    twoPhase: z.boolean().optional(),
    systemRunPlan: SystemRunPlanSchema.optional(),
  })
  .passthrough()

export type ExecApprovalRequest = z.infer<typeof ExecApprovalRequestSchema>

export const ExecApprovalRequestedSchema = z.object({
  id: z.string(),
  request: ExecApprovalRequestSchema,
  createdAtMs: z.number().optional(),
  expiresAtMs: z.number().optional(),
})

export type ExecApprovalRequested = z.infer<typeof ExecApprovalRequestedSchema>

export const ExecApprovalResolvedSchema = z
  .object({
    id: z.string(),
    decision: z.string().optional(),
    resolvedAtMs: z.number().optional(),
  })
  .passthrough()

export type ExecApprovalResolved = z.infer<typeof ExecApprovalResolvedSchema>

/**
 * Which decisions to offer for a given request.
 *
 * Always derived, never hardcoded — `unavailableDecisions` is how the host tells
 * a client that its policy forbids durable trust, and showing a button the
 * gateway will reject is worse than not showing it.
 */
export function availableDecisions(request: ExecApprovalRequest): ApprovalDecision[] {
  const blocked = new Set(request.unavailableDecisions ?? [])
  return APPROVAL_DECISIONS.filter((d) => !blocked.has(d))
}

// ─── plugin approvals ───

export const PLUGIN_APPROVAL_SEVERITIES = ['info', 'warning', 'critical'] as const
export type PluginApprovalSeverity = (typeof PLUGIN_APPROVAL_SEVERITIES)[number]

export const PluginApprovalRequestedSchema = z
  .object({
    id: z.string(),
    pluginId: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    severity: z.string().optional(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    allowedDecisions: z.array(z.string()).optional(),
    agentId: z.string().optional(),
    sessionKey: z.string().optional(),
    timeoutMs: z.number().optional(),
    twoPhase: z.boolean().optional(),
  })
  .passthrough()

export type PluginApprovalRequested = z.infer<typeof PluginApprovalRequestedSchema>

// ─── tick ───

export const TickPayloadSchema = z
  .object({ ts: z.number().optional() })
  .passthrough()
