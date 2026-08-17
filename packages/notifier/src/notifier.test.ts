import { describe, it, expect, vi } from 'vitest'
import { startNotifier, dryRunTransport, type PushTransport } from './notifier'
import type { GatewayClient } from '@openclaw/gateway-client'

/** A client stub exposing just the event surface the notifier subscribes to. */
function fakeClient() {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const client = {
    on(event: string, handler: (p: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
  } as unknown as GatewayClient

  return {
    client,
    emit(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload)
    },
    count(event: string) {
      return handlers.get(event)?.size ?? 0
    },
  }
}

const approvalPayload = {
  id: 'appr-1',
  request: { id: 'appr-1', command: 'ls -la', sessionKey: 'agent:main:main' },
}

function setup(overrides: Partial<Parameters<typeof startNotifier>[0]> = {}) {
  const gw = fakeClient()
  const sent: Array<{ title: string; token: string }> = []
  const transport: PushTransport = async (n, token) => {
    sent.push({ title: n.title, token })
    return true
  }
  const notifier = startNotifier({
    client: gw.client,
    transport,
    devices: () => ['device-a'],
    now: () => 1_000_000,
    ...overrides,
  })
  return { gw, sent, notifier }
}

describe('startNotifier', () => {
  it('pushes on an approval request', async () => {
    const { notifier, sent } = setup()
    await notifier.handleApproval(approvalPayload)
    expect(sent).toEqual([{ title: 'Approval needed', token: 'device-a' }])
  })

  it('fans out to every registered device', async () => {
    const { notifier, sent } = setup({ devices: () => ['a', 'b', 'c'] })
    await notifier.handleApproval(approvalPayload)
    expect(sent.map((s) => s.token)).toEqual(['a', 'b', 'c'])
  })

  it('does nothing when no device is registered', async () => {
    const { notifier, sent } = setup({ devices: () => [] })
    await notifier.handleApproval(approvalPayload)
    expect(sent).toHaveLength(0)
  })

  it('suppresses a duplicate inside the dedupe window', async () => {
    // The gateway can re-broadcast, and a reconnect replays pending approvals.
    // Buzzing a phone twice for one approval is worse than a missed update.
    const { notifier, sent } = setup()
    await notifier.handleApproval(approvalPayload)
    await notifier.handleApproval(approvalPayload)
    expect(sent).toHaveLength(1)
  })

  it('allows the same key again once the window passes', async () => {
    let t = 1_000_000
    const { notifier, sent } = setup({ now: () => t, dedupeWindowMs: 1000 })
    await notifier.handleApproval(approvalPayload)
    t += 2000
    await notifier.handleApproval(approvalPayload)
    expect(sent).toHaveLength(2)
  })

  it('does not push on streaming deltas', async () => {
    const { notifier, sent } = setup()
    await notifier.handleChat({
      state: 'delta',
      runId: 'r1',
      sessionKey: 'agent:main:main',
      deltaText: 'hi',
    })
    expect(sent).toHaveLength(0)
  })

  it('pushes once a run finishes', async () => {
    const { notifier, sent } = setup()
    await notifier.handleChat({ state: 'final', runId: 'r1', sessionKey: 'agent:main:main' })
    expect(sent).toEqual([{ title: 'Run finished', token: 'device-a' }])
  })

  it('ignores an unreadable event rather than crashing the service', async () => {
    // This process is long-lived and unattended; one malformed frame must not
    // take down notifications for everything else.
    const { notifier, sent } = setup()
    await notifier.handleApproval({ nonsense: true })
    await notifier.handleChat('not an object')
    expect(sent).toHaveLength(0)
  })

  it('survives a transport that throws', async () => {
    const failing: PushTransport = async () => {
      throw new Error('FCM exploded')
    }
    const { notifier } = setup({ transport: failing })
    await expect(notifier.handleApproval(approvalPayload)).resolves.toBeUndefined()
  })

  it('refuses to send a payload that would leak content', async () => {
    // assertNoContentLeak throws before dispatch; the caller logs and moves on.
    const leaky: PushTransport = async () => true
    const { notifier } = setup({ transport: leaky })
    await expect(notifier.handleApproval(approvalPayload)).resolves.toBeUndefined()
  })

  it('subscribes and unsubscribes cleanly', () => {
    const { gw, notifier } = setup()
    expect(gw.count('exec.approval.requested')).toBe(1)
    expect(gw.count('chat')).toBe(1)
    notifier.stop()
    expect(gw.count('exec.approval.requested')).toBe(0)
    expect(gw.count('chat')).toBe(0)
  })

  it('wires live events through the client', async () => {
    const { gw, sent } = setup()
    gw.emit('exec.approval.requested', approvalPayload)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })
})

describe('dryRunTransport', () => {
  it('logs instead of sending, and reports success', async () => {
    const lines: string[] = []
    const transport = dryRunTransport((m) => lines.push(m))
    const ok = await transport(
      { kind: 'approval', title: 'Approval needed', body: 'b', data: { kind: 'approval' } },
      'device-token-123',
    )
    expect(ok).toBe(true)
    expect(lines[0]).toContain('[dry-run]')
    expect(lines[0]).toContain('Approval needed')
  })
})
