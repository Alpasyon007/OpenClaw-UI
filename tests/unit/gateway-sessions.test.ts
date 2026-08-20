import { describe, expect, it } from 'vitest'
import {
  toEpochMs,
  mapGatewaySession,
  sortGatewaySessions,
  mapGatewayMessages,
  classifyGatewayFailure,
  readGatewaySessions,
  readGatewaySessionHistory,
  NO_CREDENTIAL,
  MAX_GATEWAY_SESSIONS,
} from '../../src/main/gateway-sessions'
import type { GatewayCall, GatewayRpcResult } from '../../src/main/gateway-sessions'

/**
 * Sessions that live on the gateway.
 *
 * Every branch here is a degradation branch, which is the whole point: this
 * module renders directly into the history picker beside the local session
 * list, and a gateway that is down, old, credential-less or answering nonsense
 * must never be able to disturb that list. So the readers are asserted to
 * *never throw* and to always answer a fully-populated result.
 *
 * The wire shapes below are trimmed copies of real replies from
 * `openclaw gateway call sessions.list` and `chat.history`.
 */

const ok = (body: unknown): GatewayCall => async () => ({ body, errorMessage: null })
const fails = (errorMessage: string): GatewayCall => async () => ({ body: null, errorMessage })
const throws = (): GatewayCall => async () => {
  throw new Error('spawn ENOENT')
}

const NOW = 1_786_845_427_362

describe('toEpochMs', () => {
  it('accepts epoch numbers and ISO strings', () => {
    expect(toEpochMs(NOW)).toBe(NOW)
    expect(toEpochMs('2026-08-16T00:00:00.000Z')).toBe(Date.parse('2026-08-16T00:00:00.000Z'))
  })

  it('is never NaN, because a NaN comparator makes sort order-dependent', () => {
    for (const bad of [undefined, null, 'not a date', {}, [], NaN, Infinity]) {
      expect(toEpochMs(bad)).toBe(0)
    }
  })
})

describe('mapGatewaySession', () => {
  it('maps a real sessions.list row', () => {
    const meta = mapGatewaySession({
      key: 'agent:main:dashboard:9ce7466d',
      kind: 'direct',
      displayName: 'Nova Node Permissions Issue',
      updatedAt: NOW,
      sessionId: 'e3677627-1d10-4295-a6e4-655502f67a15',
      model: 'deepseek-v4-flash:cloud',
      totalTokens: 70821,
      status: 'done',
      archived: false,
    })
    expect(meta).toMatchObject({
      sessionKey: 'agent:main:dashboard:9ce7466d',
      displayName: 'Nova Node Permissions Issue',
      sessionId: 'e3677627-1d10-4295-a6e4-655502f67a15',
      model: 'deepseek-v4-flash:cloud',
      totalTokens: 70821,
      status: 'done',
      hasActiveRun: false,
    })
    expect(meta!.lastTimestamp).toBe(new Date(NOW).toISOString())
  })

  it('rejects a row with no key — an id-less row can be neither drawn nor resumed', () => {
    expect(mapGatewaySession({ updatedAt: NOW })).toBeNull()
    expect(mapGatewaySession({ key: '   ' })).toBeNull()
    expect(mapGatewaySession(null)).toBeNull()
    expect(mapGatewaySession('agent:main:main')).toBeNull()
    expect(mapGatewaySession([])).toBeNull()
  })

  it('treats only a literal true as a flag', () => {
    const meta = mapGatewaySession({
      key: 'k',
      hasActiveRun: 'true',
      archived: 1,
      pinned: 'yes',
      unread: {},
    })
    expect(meta).toMatchObject({ hasActiveRun: false, archived: false, pinned: false, unread: false })
  })

  it('falls back through the timestamp fields, and tolerates none of them', () => {
    expect(mapGatewaySession({ key: 'k', startedAt: NOW })!.lastTimestamp).toBe(
      new Date(NOW).toISOString(),
    )
    expect(mapGatewaySession({ key: 'k' })!.lastTimestamp).toBeNull()
  })

  it('nulls empty strings and non-finite numbers rather than passing them through', () => {
    const meta = mapGatewaySession({ key: 'k', model: '  ', displayName: '', totalTokens: NaN })
    expect(meta).toMatchObject({ model: null, displayName: null, totalTokens: null })
  })
})

describe('sortGatewaySessions', () => {
  it('puts the most recently active first and undated rows last', () => {
    const row = (sessionKey: string, lastTimestamp: string | null) =>
      mapGatewaySession({ key: sessionKey, updatedAt: lastTimestamp ?? undefined })!
    const sorted = [
      row('old', '2026-01-01T00:00:00.000Z'),
      row('undated', null),
      row('new', '2026-08-01T00:00:00.000Z'),
    ].sort(sortGatewaySessions)
    expect(sorted.map((s) => s.sessionKey)).toEqual(['new', 'old', 'undated'])
  })
})

describe('classifyGatewayFailure', () => {
  it('treats an unknown method as "nothing to show" rather than an error', () => {
    // The picker hides the group on 'unsupported'; a gateway that predates
    // sessions.list is a normal state, not a failure worth explaining.
    const { reason, error } = classifyGatewayFailure('unknown method: sessions.list')
    expect(reason).toBe('unsupported')
    expect(error).toBeNull()
  })

  it('names a missing credential', () => {
    expect(classifyGatewayFailure(NO_CREDENTIAL).reason).toBe('no-credential')
  })

  it('falls back to unreachable, and never leaks raw CLI text', () => {
    const { reason, error } = classifyGatewayFailure('connect ECONNREFUSED 10.0.0.1:443\n  at Socket')
    expect(reason).toBe('unreachable')
    expect(error).toBe('Could not reach the gateway.')
  })
})

describe('readGatewaySessions', () => {
  it('maps, filters archived, and sorts', async () => {
    const res = await readGatewaySessions(
      ok({
        sessions: [
          { key: 'agent:main:old', updatedAt: 1000 },
          { key: 'agent:main:archived', updatedAt: 9999, archived: true },
          { key: 'agent:main:new', updatedAt: 5000 },
          { notAKey: true },
        ],
      }),
      NOW,
    )
    expect(res.available).toBe(true)
    expect(res.sessions.map((s) => s.sessionKey)).toEqual(['agent:main:new', 'agent:main:old'])
    expect(res.fetchedAt).toBe(NOW)
  })

  it('caps the list', async () => {
    const sessions = Array.from({ length: MAX_GATEWAY_SESSIONS + 25 }, (_, i) => ({
      key: `agent:main:s${i}`,
      updatedAt: i,
    }))
    const res = await readGatewaySessions(ok({ sessions }), NOW)
    expect(res.sessions).toHaveLength(MAX_GATEWAY_SESSIONS)
  })

  it('degrades to unsupported on an unknown method', async () => {
    const res = await readGatewaySessions(fails('unknown method: sessions.list'), NOW)
    expect(res).toMatchObject({ ok: false, available: false, reason: 'unsupported', error: null })
    expect(res.sessions).toEqual([])
  })

  it('degrades to no-credential without pretending it reached anything', async () => {
    const res = await readGatewaySessions(fails(NO_CREDENTIAL), NOW)
    expect(res).toMatchObject({ available: false, reason: 'no-credential' })
  })

  it('never throws, even when the call itself does', async () => {
    const res = await readGatewaySessions(throws(), NOW)
    expect(res).toMatchObject({ ok: false, available: false, reason: 'unreachable' })
    expect(res.sessions).toEqual([])
  })

  it('survives a reply that is the wrong shape entirely', async () => {
    for (const body of [null, {}, { sessions: 'nope' }, { sessions: [null, 3, 'x'] }, []]) {
      const res = await readGatewaySessions(ok(body), NOW)
      expect(res.available).toBe(true)
      expect(res.sessions).toEqual([])
    }
  })
})

describe('mapGatewayMessages', () => {
  const history = {
    totalMessages: 44,
    hasMore: true,
    messages: [
      { role: 'user', content: 'first', timestamp: 2, __openclaw: { seq: 2 } },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'ls' } },
        ],
        timestamp: 3,
        __openclaw: { seq: 3 },
      },
      // Deliberately out of order on the wire.
      { role: 'user', content: 'zeroth', timestamp: 1, __openclaw: { seq: 1 } },
      { role: 'toolResult', toolName: 'exec', content: [{ type: 'text', text: 'SECRET OUTPUT' }], timestamp: 4, __openclaw: { seq: 4 } },
    ],
  }

  it('orders by seq, oldest first', () => {
    const { messages } = mapGatewayMessages(history, 200)
    expect(messages.map((m) => m.content)).toEqual(['zeroth', 'first', 'thinking', ''])
  })

  it('carries tool names but never tool results', () => {
    const { messages } = mapGatewayMessages(history, 200)
    const tools = messages.filter((m) => m.role === 'tool')
    expect(tools).toEqual([{ role: 'tool', content: '', toolName: 'exec', timestamp: 3 }])
    // Untrusted third-party bytes must not reach the renderer at all.
    expect(JSON.stringify(messages)).not.toContain('SECRET OUTPUT')
  })

  it('reports truncation from hasMore and from the total', () => {
    expect(mapGatewayMessages(history, 200).truncated).toBe(true)
    expect(mapGatewayMessages({ messages: [], totalMessages: 500 }, 200).truncated).toBe(true)
    expect(mapGatewayMessages({ messages: [], totalMessages: 3 }, 200).truncated).toBe(false)
  })

  it('leaves wire order alone when the rows cannot all be ordered', () => {
    const { messages } = mapGatewayMessages(
      { messages: [{ role: 'user', content: 'b', timestamp: 2 }, { role: 'user', content: 'a', timestamp: 1 }] },
      200,
    )
    expect(messages.map((m) => m.content)).toEqual(['b', 'a'])
  })

  it('skips empty and malformed entries', () => {
    const { messages } = mapGatewayMessages(
      { messages: [null, 'x', { role: 'user' }, { role: 'user', content: '   ' }, { role: 'system', content: 'no' }] },
      200,
    )
    expect(messages).toEqual([])
  })
})

describe('readGatewaySessionHistory', () => {
  it('requests the newest page — offset 0 is mandatory', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const spy: GatewayCall = async (method, params): Promise<GatewayRpcResult> => {
      seen.push({ method, params })
      return { body: { messages: [] }, errorMessage: null }
    }
    await readGatewaySessionHistory(spy, 'agent:main:main', 50)
    expect(seen[0].method).toBe('chat.history')
    // Sending `limit` alone silently omits totalMessages and hasMore, so
    // truncation could never be reported.
    expect(seen[0].params).toEqual({ sessionKey: 'agent:main:main', limit: 50, offset: 0 })
  })

  it('rejects an empty key without calling anything', async () => {
    let called = false
    const spy: GatewayCall = async () => {
      called = true
      return { body: null, errorMessage: null }
    }
    const res = await readGatewaySessionHistory(spy, '  ')
    expect(called).toBe(false)
    expect(res.ok).toBe(false)
    expect(res.messages).toEqual([])
  })

  it('never throws, and reports a readable reason', async () => {
    const thrown = await readGatewaySessionHistory(throws(), 'agent:main:main')
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toBe('Could not reach the gateway.')

    const refused = await readGatewaySessionHistory(fails('boom'), 'agent:main:main')
    expect(refused.messages).toEqual([])
    expect(refused.error).toBe('Could not load this session from the gateway.')

    const noCred = await readGatewaySessionHistory(fails(NO_CREDENTIAL), 'agent:main:main')
    expect(noCred.error).toContain('credential')
  })
})
