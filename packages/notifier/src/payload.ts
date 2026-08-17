/**
 * Notification payloads.
 *
 * The gateway cannot push to Android at all — its APNs path is gated on
 * `isIosPlatform`, and its Web Push sender is only ever invoked by
 * `push.web.test`, so no event triggers it. This service exists to close that
 * gap: it connects as an ordinary operator client and does the fan-out itself.
 *
 * **The privacy rule is the whole design.** A push payload travels through FCM
 * and lands in the OS notification store, where it is readable on a lock screen
 * and retained outside the app's control. Transcripts contain source code,
 * credentials and whatever the agent has been reading. So payloads carry an
 * opaque *pointer* — ids the app resolves over its own authenticated socket
 * after unlocking — and never the content itself.
 *
 * That is why these builders are pure and separately tested: the guarantee is
 * only worth as much as the test that a command string cannot reach a payload.
 */
import type { ChatEvent, ExecApprovalRequested } from '@openclaw/protocol'

export type NotificationKind = 'approval' | 'run-complete' | 'run-failed'

export interface PushNotification {
  kind: NotificationKind
  /** Shown on the lock screen. Deliberately generic. */
  title: string
  body: string
  /** Resolved by the app after unlock. Ids only — never content. */
  data: Record<string, string>
  /** Collapses supersedable notifications, e.g. repeated run updates. */
  collapseKey?: string
}

export function approvalNotification(event: ExecApprovalRequested): PushNotification {
  return {
    kind: 'approval',
    // No command, no cwd, no host detail. "A command" is all the lock screen
    // needs to convey urgency; the app shows the specifics after unlock.
    title: 'Approval needed',
    body: 'The agent is waiting to run a command.',
    data: {
      kind: 'approval',
      approvalId: event.id,
      ...(event.request.sessionKey ? { sessionKey: event.request.sessionKey } : {}),
      ...(event.request.agentId ? { agentId: event.request.agentId } : {}),
    },
    collapseKey: `approval:${event.id}`,
  }
}

/** Terminal run states worth waking a phone for. */
export function runNotification(event: ChatEvent): PushNotification | null {
  if (event.state === 'delta') return null

  // An aborted run was almost always cancelled by the user, who therefore
  // already knows. Waking them to say so is noise.
  if (event.state === 'aborted') return null

  const failed = event.state === 'error'
  return {
    kind: failed ? 'run-failed' : 'run-complete',
    title: failed ? 'Run failed' : 'Run finished',
    // No result text and no error message: both are transcript content.
    body: failed ? 'The agent stopped with an error.' : 'The agent finished its turn.',
    data: {
      kind: failed ? 'run-failed' : 'run-complete',
      sessionKey: event.sessionKey,
      runId: event.runId,
    },
    // One notification per run, superseding earlier updates for it.
    collapseKey: `run:${event.runId}`,
  }
}

/**
 * Assert a notification carries no content from its source event.
 *
 * Called on every notification before dispatch. A payload that leaks is worse
 * than no notification at all, and the failure is invisible at runtime — it
 * looks like a perfectly good push.
 */
export function assertNoContentLeak(notification: PushNotification, source: unknown): void {
  const serialized = JSON.stringify(notification)
  const values = collectStrings(source)

  for (const value of values) {
    // Short values produce false positives — an id legitimately appears in
    // both. Only substantial strings indicate real content.
    if (value.length < 12) continue
    if (serialized.includes(value) && !isIdLike(notification, value)) {
      throw new Error(
        `notification would leak source content (${value.length} chars) — payloads carry ids only`,
      )
    }
  }
}

/** Ids are permitted; they are the pointer the design depends on. */
function isIdLike(notification: PushNotification, value: string): boolean {
  return Object.values(notification.data).includes(value)
}

/**
 * Every string anywhere in the source.
 *
 * Deliberately not a denylist of known-sensitive field names. A denylist only
 * catches the fields someone thought of, and the gateway adds fields freely —
 * checking everything means a new field carrying transcript text is caught the
 * first time it appears rather than the first time someone notices.
 */
function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth + 1))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) =>
      collectStrings(v, depth + 1),
    )
  }
  return []
}
