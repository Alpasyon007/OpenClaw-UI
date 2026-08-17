import { describe, it, expect } from 'vitest'
import {
  parseServerFrame,
  ServerFrameSchema,
  ErrorShapeSchema,
  ERROR_CODES,
  PROTOCOL_VERSION,
} from './frames'

describe('parseServerFrame', () => {
  it('parses a response frame', () => {
    const result = parseServerFrame('{"type":"res","id":"1","ok":true,"payload":{"a":1}}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.type).toBe('res')
  })

  it('parses an event frame', () => {
    const result = parseServerFrame('{"type":"event","event":"chat","payload":{},"seq":7}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.type).toBe('event')
    if (result.frame.type !== 'event') return
    expect(result.frame.event).toBe('chat')
    expect(result.frame.seq).toBe(7)
  })

  it('parses a real `health` frame captured from the live gateway', () => {
    // Regression, from an actual wire capture. `stateVersion` is a MAP of
    // per-stream counters, not a version number — an earlier revision typed it
    // as z.number(), so every health event failed to parse and was dropped as
    // unreadable. The fake gateway could not catch this: it was written from
    // the same wrong assumption.
    const captured =
      '{"type":"event","event":"health","payload":{"ok":true,"ts":1786922713535,"durationMs":8},' +
      '"seq":1,"stateVersion":{"presence":1091,"health":37631}}'

    const result = parseServerFrame(captured)
    expect(result.ok).toBe(true)
    if (!result.ok || result.frame.type !== 'event') return
    expect(result.frame.event).toBe('health')
    expect(result.frame.seq).toBe(1)
    expect(result.frame.stateVersion).toEqual({ presence: 1091, health: 37631 })
  })

  it('accepts stateVersion in whatever shape it arrives', () => {
    for (const stateVersion of [1, { a: 1 }, null, 'x', [1, 2]]) {
      const raw = JSON.stringify({ type: 'event', event: 'e', stateVersion })
      expect(parseServerFrame(raw).ok).toBe(true)
    }
  })

  it('parses an event frame with no payload', () => {
    // `tick` arrives bare. Requiring a payload would drop the heartbeat and the
    // client would then close its own healthy socket on the silence timer.
    const result = parseServerFrame('{"type":"event","event":"tick"}')
    expect(result.ok).toBe(true)
  })

  it('carries a failed response error through', () => {
    const result = parseServerFrame(
      '{"type":"res","id":"1","ok":false,"error":{"code":"UNAVAILABLE","message":"booting","retryable":true}}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok || result.frame.type !== 'res') return
    expect(result.frame.error?.code).toBe('UNAVAILABLE')
    expect(result.frame.error?.retryable).toBe(true)
  })

  // ─── must not throw ───

  it.each([
    ['not json at all', 'hello'],
    ['empty string', ''],
    ['a bare number', '42'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['an unknown frame type', '{"type":"banana"}'],
    ['a response missing id', '{"type":"res","ok":true}'],
    ['an event missing name', '{"type":"event"}'],
    ['a truncated object', '{"type":"res","id":'],
  ])('never throws on %s', (_label, raw) => {
    expect(() => parseServerFrame(raw)).not.toThrow()
    expect(parseServerFrame(raw).ok).toBe(false)
  })

  it('does not echo frame contents into the error string', () => {
    // This string ends up in logs. Frames carry transcript text and approval
    // payloads, so the diagnostic must describe the shape, never the contents.
    const secret = 'sk-live-do-not-log-me'
    const result = parseServerFrame(`{"type":"res","secretField":"${secret}"}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).not.toContain(secret)
  })

  it('reports the offending type to make a mismatch diagnosable', () => {
    const result = parseServerFrame('{"type":"banana"}')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('banana')
  })
})

describe('ErrorShapeSchema', () => {
  it('accepts a code outside the known set', () => {
    // A gateway newer than this client will invent codes. Rejecting one would
    // turn "unfamiliar error" into "the connection is broken".
    const parsed = ErrorShapeSchema.safeParse({ code: 'SOME_FUTURE_CODE', message: 'x' })
    expect(parsed.success).toBe(true)
  })

  it('keeps unrecognised detail fields', () => {
    const parsed = ErrorShapeSchema.safeParse({
      code: 'NOT_PAIRED',
      message: 'x',
      details: { reason: 'not-paired', somethingNew: true },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.details?.somethingNew).toBe(true)
  })
})

describe('constants', () => {
  it('speaks protocol 4', () => {
    // Operator sessions must be current; only nodes get an N-1 window. If this
    // ever needs to change it is a deliberate migration, not an incidental edit.
    expect(PROTOCOL_VERSION).toBe(4)
  })

  it('guards the guard: the error code set is non-trivial', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(4)
  })

  it('exposes a discriminated union over all three frame shapes', () => {
    const shapes = ['res', 'event', 'req']
    for (const type of shapes) {
      expect(ServerFrameSchema.options.some((o) => o.shape.type.value === type)).toBe(true)
    }
  })
})
