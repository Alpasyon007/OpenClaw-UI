/**
 * Session-scoped events.
 *
 * These differ from `chat` in a way that is easy to miss and produces a silent
 * gap: `chat` is broadcast to *every* operator client holding `operator.read`,
 * but `session.tool` and `session.message` go only to `sessionSubscribers` —
 * clients that have called `sessions.subscribe` for that key. A client that
 * never subscribes sees assistant prose appear with no indication the agent
 * ran anything, which reads as the agent doing nothing for long stretches.
 */
import { z } from 'zod'

export const EVENT_SESSION_TOOL = 'session.tool'
export const EVENT_SESSION_MESSAGE = 'session.message'
export const EVENT_SESSION_OPERATION = 'session.operation'

/**
 * A tool invocation.
 *
 * Modelled loosely on purpose. Tool payloads are shaped by whichever tool ran,
 * the set grows with every plugin, and the fields below are only the ones the
 * UI needs to render a card. Anything stricter would drop cards for tools this
 * client has never heard of — exactly the tools a user most wants to see.
 */
export const SessionToolEventSchema = z
  .object({
    sessionKey: z.string().optional(),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    /** Correlates start/end for the same invocation. */
    toolCallId: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    /** 'start' | 'end' | 'error' on observed payloads; kept open. */
    phase: z.string().optional(),
    status: z.string().optional(),
    /** Arguments the tool was called with. Untrusted — render inert. */
    input: z.unknown().optional(),
    args: z.unknown().optional(),
    /** Present on completion. Frequently large; the UI truncates. */
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    durationMs: z.number().optional(),
    seq: z.number().optional(),
  })
  .passthrough()

export type SessionToolEvent = z.infer<typeof SessionToolEventSchema>

/** The tool's display name, whichever field carried it. */
export function toolName(event: SessionToolEvent): string {
  return event.name ?? event.tool ?? 'tool'
}

/** Stable id for correlating a start with its completion. */
export function toolCallKey(event: SessionToolEvent): string {
  return event.toolCallId ?? event.id ?? `${toolName(event)}:${event.seq ?? 0}`
}

export type ToolPhase = 'running' | 'complete' | 'error'

/**
 * Normalise the many ways a payload can say "this finished".
 *
 * Different tools report completion via `phase`, `status`, or simply by
 * carrying a `result`. Treating only one of those as terminal leaves cards
 * spinning forever.
 */
export function toolPhase(event: SessionToolEvent): ToolPhase {
  const raw = `${event.phase ?? ''}|${event.status ?? ''}`.toLowerCase()
  if (event.error != null || raw.includes('error') || raw.includes('fail')) return 'error'
  if (raw.includes('start') || raw.includes('running')) return 'running'
  if (event.result !== undefined || raw.includes('end') || raw.includes('complete') || raw.includes('ok')) {
    return 'complete'
  }
  return 'running'
}

/** Params for `sessions.subscribe` / `sessions.messages.subscribe`. */
export const SessionSubscribeParamsSchema = z.object({
  key: z.string().min(1),
  agentId: z.string().optional(),
})
