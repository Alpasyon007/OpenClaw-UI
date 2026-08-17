import { describe, it, expect } from 'vitest'
import {
  classifyConnectError,
  isRetryableConnectRejection,
  COMPANION_SCOPES,
  SCOPES,
  HelloOkSchema,
  ConnectChallengePayloadSchema,
  PAIRING_REASONS,
} from './connect'

describe('classifyConnectError', () => {
  it('recognises pairing-required and its reason', () => {
    const r = classifyConnectError({
      code: 'NOT_PAIRED',
      message: 'device pairing required',
      details: { code: 'PAIRING_REQUIRED', reason: 'not-paired' },
      retryable: true,
    })
    expect(r.kind).toBe('pairing-required')
    if (r.kind !== 'pairing-required') return
    expect(r.reason).toBe('not-paired')
  })

  it.each(PAIRING_REASONS)('recognises the %s pairing reason', (reason) => {
    // The desktop scrapes the human message with a regex that catches
    // `not-paired` and `scope-upgrade` but misses `role-upgrade` and
    // `metadata-upgrade`. Classifying on details.code must catch all four.
    const r = classifyConnectError({
      code: 'NOT_PAIRED',
      message: 'something human-readable that we deliberately do not parse',
      details: { code: 'PAIRING_REQUIRED', reason },
    })
    expect(r.kind).toBe('pairing-required')
    if (r.kind !== 'pairing-required') return
    expect(r.reason).toBe(reason)
  })

  it('still reports pairing-required when the reason is unrecognised', () => {
    const r = classifyConnectError({
      code: 'NOT_PAIRED',
      message: 'x',
      details: { code: 'PAIRING_REQUIRED', reason: 'a-reason-invented-later' },
    })
    expect(r.kind).toBe('pairing-required')
    if (r.kind !== 'pairing-required') return
    // Unknown reason degrades to null rather than rejecting the classification —
    // the retry behaviour is identical regardless of why pairing is pending.
    expect(r.reason).toBeNull()
  })

  it('recognises the startup-sidecars race', () => {
    const r = classifyConnectError({
      code: 'UNAVAILABLE',
      message: 'starting',
      details: { reason: 'startup-sidecars' },
      retryable: true,
      retryAfterMs: 500,
    })
    expect(r.kind).toBe('unavailable')
    if (r.kind !== 'unavailable') return
    expect(r.reason).toBe('startup-sidecars')
    expect(r.retryAfterMs).toBe(500)
  })

  it('classifies auth failures with their recovery hint', () => {
    const r = classifyConnectError({
      code: 'INVALID_REQUEST',
      message: 'token mismatch',
      details: { code: 'AUTH_TOKEN_MISMATCH', recommendedNextStep: 'retry_with_device_token' },
    })
    expect(r.kind).toBe('auth')
    if (r.kind !== 'auth') return
    expect(r.code).toBe('AUTH_TOKEN_MISMATCH')
    expect(r.recommendedNextStep).toBe('retry_with_device_token')
  })

  it('classifies device-identity failures as auth', () => {
    const r = classifyConnectError({
      code: 'INVALID_REQUEST',
      message: 'bad signature',
      details: { code: 'DEVICE_AUTH_SIGNATURE_INVALID' },
    })
    expect(r.kind).toBe('auth')
  })

  it('classifies a protocol mismatch separately from auth', () => {
    // These must not be retried: the client is simply too old, and retrying
    // burns the auth rate limiter for nothing.
    const r = classifyConnectError({
      code: 'INVALID_REQUEST',
      message: 'protocol 3 < 4',
      details: { code: 'PROTOCOL_MISMATCH' },
    })
    expect(r.kind).toBe('protocol-mismatch')
  })

  // ─── must not throw, must not over-retry ───

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'boom'],
    ['a number', 7],
    ['an empty object', {}],
    ['an object missing message', { code: 'X' }],
  ])('never throws on %s', (_label, input) => {
    expect(() => classifyConnectError(input)).not.toThrow()
    expect(classifyConnectError(input).kind).toBe('unknown')
  })

  it('treats an unrecognised error as fatal, not retryable', () => {
    // Defaulting the other way would have a client hammering the gateway's auth
    // rate limiter (10 attempts / 60s → 300s lockout) over an error it cannot
    // act on.
    const r = classifyConnectError({ code: 'SOMETHING_NEW', message: 'x' })
    expect(isRetryableConnectRejection(r)).toBe(false)
  })

  it('retries exactly the two recoverable outcomes', () => {
    const pairing = classifyConnectError({
      code: 'NOT_PAIRED',
      message: 'x',
      details: { code: 'PAIRING_REQUIRED' },
    })
    const unavailable = classifyConnectError({ code: 'UNAVAILABLE', message: 'x' })
    const auth = classifyConnectError({
      code: 'INVALID_REQUEST',
      message: 'x',
      details: { code: 'AUTH_TOKEN_MISMATCH' },
    })

    expect(isRetryableConnectRejection(pairing)).toBe(true)
    expect(isRetryableConnectRejection(unavailable)).toBe(true)
    expect(isRetryableConnectRejection(auth)).toBe(false)
  })
})

describe('scopes', () => {
  it('asks for read, write and approvals', () => {
    expect([...COMPANION_SCOPES].sort()).toEqual([
      'operator.approvals',
      'operator.read',
      'operator.write',
    ])
  })

  it('never asks for admin or pairing', () => {
    // admin satisfies every other operator scope and unlocks config mutation,
    // updates and terminal access. A phone requesting it turns a routine pairing
    // prompt into one a user should refuse.
    expect(COMPANION_SCOPES).not.toContain('operator.admin')
    expect(COMPANION_SCOPES).not.toContain('operator.pairing')
  })

  it('guards the guard: the scope set is the documented six', () => {
    expect(SCOPES).toHaveLength(6)
  })
})

describe('HelloOkSchema', () => {
  it('parses a minimal hello-ok', () => {
    const parsed = HelloOkSchema.safeParse({ type: 'hello-ok', protocol: 4 })
    expect(parsed.success).toBe(true)
  })

  it('carries the bootstrap device tokens', () => {
    const parsed = HelloOkSchema.safeParse({
      type: 'hello-ok',
      protocol: 4,
      auth: {
        role: 'node',
        scopes: [],
        deviceToken: 'redacted',
        deviceTokens: [
          { deviceToken: 'redacted', role: 'operator', scopes: ['operator.read'] },
        ],
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.auth?.deviceTokens?.[0]?.role).toBe('operator')
  })

  it('survives an unknown snapshot shape', () => {
    // `snapshot` is schema-required by the gateway but undocumented. Guessing at
    // its shape would reject perfectly good handshakes.
    const parsed = HelloOkSchema.safeParse({
      type: 'hello-ok',
      protocol: 4,
      snapshot: { anything: [1, 2, { nested: true }] },
    })
    expect(parsed.success).toBe(true)
  })

  it('defaults granted scopes to empty rather than undefined', () => {
    const parsed = HelloOkSchema.safeParse({ type: 'hello-ok', protocol: 4, auth: { role: 'operator' } })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.auth?.scopes).toEqual([])
  })
})

describe('ConnectChallengePayloadSchema', () => {
  it('requires a nonce', () => {
    expect(ConnectChallengePayloadSchema.safeParse({ ts: 1 }).success).toBe(false)
    expect(ConnectChallengePayloadSchema.safeParse({ nonce: '' }).success).toBe(false)
    expect(ConnectChallengePayloadSchema.safeParse({ nonce: 'abc' }).success).toBe(true)
  })
})
