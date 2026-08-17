/**
 * The notifier: an ordinary operator client that fans gateway events out to a
 * push transport.
 *
 * It needs no gateway changes, which is what keeps it small. It holds
 * `operator.read` (for `chat`) and `operator.approvals` (for
 * `exec.approval.requested`) and nothing else — it never sends prompts and
 * never resolves approvals, so a compromise of this service cannot act as the
 * user.
 *
 * The transport is injected. That keeps FCM credentials out of the logic, lets
 * the tests assert on payloads rather than on HTTP, and makes a dry run — which
 * logs what it *would* send — a first-class mode rather than an afterthought.
 */
import {
  ChatEventSchema,
  ExecApprovalRequestedSchema,
  EVENT_CHAT,
  EVENT_EXEC_APPROVAL_REQUESTED,
} from '@openclaw/protocol'
import type { GatewayClient } from '@openclaw/gateway-client'
import {
  approvalNotification,
  runNotification,
  assertNoContentLeak,
  type PushNotification,
} from './payload'

/** Delivers a notification. Returns false if the device should be dropped. */
export type PushTransport = (
  notification: PushNotification,
  deviceToken: string,
) => Promise<boolean>

export interface NotifierOptions {
  client: GatewayClient
  transport: PushTransport
  /** Registered device tokens. Supplied by the caller's own store. */
  devices: () => string[]
  onLog?: (message: string) => void
  /** Suppress duplicates within this window, keyed by collapseKey. */
  dedupeWindowMs?: number
  now?: () => number
}

export interface Notifier {
  stop: () => void
  /** Exposed for tests and for a dry run. */
  handleApproval: (payload: unknown) => Promise<void>
  handleChat: (payload: unknown) => Promise<void>
}

export function startNotifier(options: NotifierOptions): Notifier {
  const {
    client,
    transport,
    devices,
    onLog = () => {},
    dedupeWindowMs = 30_000,
    now = Date.now,
  } = options

  /** collapseKey -> last sent at. */
  const recent = new Map<string, number>()

  function shouldSend(notification: PushNotification): boolean {
    const key = notification.collapseKey
    if (!key) return true
    const last = recent.get(key)
    if (last !== undefined && now() - last < dedupeWindowMs) return false
    recent.set(key, now())

    // Bound the map: this process is long-lived and a run id is never reused.
    if (recent.size > 1000) {
      const cutoff = now() - dedupeWindowMs
      for (const [k, t] of recent) if (t < cutoff) recent.delete(k)
    }
    return true
  }

  async function dispatch(notification: PushNotification, source: unknown): Promise<void> {
    // Throws rather than sending a leaking payload. A push that leaks
    // transcript content cannot be recalled once it is on a lock screen.
    assertNoContentLeak(notification, source)

    if (!shouldSend(notification)) {
      onLog(`suppressed duplicate ${notification.kind} (${notification.collapseKey})`)
      return
    }

    const tokens = devices()
    if (tokens.length === 0) {
      onLog(`no registered devices — dropping ${notification.kind}`)
      return
    }

    const results = await Promise.allSettled(
      tokens.map((token) => transport(notification, token)),
    )
    const delivered = results.filter((r) => r.status === 'fulfilled' && r.value).length
    onLog(`${notification.kind}: delivered to ${delivered}/${tokens.length} device(s)`)
  }

  const handleApproval = async (payload: unknown): Promise<void> => {
    const parsed = ExecApprovalRequestedSchema.safeParse(payload)
    if (!parsed.success) {
      onLog('ignored an unreadable approval event')
      return
    }
    await dispatch(approvalNotification(parsed.data), parsed.data)
  }

  const handleChat = async (payload: unknown): Promise<void> => {
    const parsed = ChatEventSchema.safeParse(payload)
    if (!parsed.success) return
    const notification = runNotification(parsed.data)
    if (!notification) return
    await dispatch(notification, parsed.data)
  }

  const offApproval = client.on(EVENT_EXEC_APPROVAL_REQUESTED, (payload) => {
    void handleApproval(payload).catch((err: unknown) => onLog(`approval dispatch failed: ${String(err)}`))
  })

  const offChat = client.on(EVENT_CHAT, (payload) => {
    void handleChat(payload).catch((err: unknown) => onLog(`chat dispatch failed: ${String(err)}`))
  })

  return {
    stop() {
      offApproval()
      offChat()
    },
    handleApproval,
    handleChat,
  }
}

/** Logs what it would send. Useful before FCM credentials exist. */
export const dryRunTransport =
  (log: (message: string) => void): PushTransport =>
  async (notification, deviceToken) => {
    log(
      `[dry-run] -> ${deviceToken.slice(0, 8)}…  ${notification.title}: ${notification.body}  ${JSON.stringify(notification.data)}`,
    )
    return true
  }
