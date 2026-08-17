import { describe, it, expect } from 'vitest'
import {
  deviceIdentityFromPrivateKey,
  signConnectChallenge,
  base64UrlEncode,
} from '@openclaw/gateway-client'
import * as ed from '@noble/ed25519'
import { utf8Bytes } from '@openclaw/gateway-client'
import {
  DeviceRegistry,
  createMemoryStore,
  buildRegistrationPayload,
  REGISTRATION_SKEW_MS,
  type RegistrationRequest,
} from './registry'

const identity = deviceIdentityFromPrivateKey(new Uint8Array(32).fill(9))
const other = deviceIdentityFromPrivateKey(new Uint8Array(32).fill(11))
const NOW = 1_700_000_000_000

function signedRegistration(
  overrides: Partial<RegistrationRequest> = {},
  signer = identity,
): RegistrationRequest {
  const deviceId = overrides.deviceId ?? signer.deviceId
  const pushToken = overrides.pushToken ?? 'fcm-token-abc'
  const signedAt = overrides.signedAt ?? NOW
  const payload = buildRegistrationPayload({ deviceId, pushToken, signedAtMs: signedAt })
  const signature = base64UrlEncode(ed.sign(utf8Bytes(payload), signer.privateKey))
  return {
    deviceId,
    publicKey: signer.publicKeyB64Url,
    pushToken,
    signedAt,
    signature,
    ...overrides,
  }
}

const makeRegistry = () => new DeviceRegistry(createMemoryStore(), () => NOW)

describe('register', () => {
  it('accepts a correctly signed registration', () => {
    const registry = makeRegistry()
    const result = registry.register(signedRegistration())
    expect(result.ok).toBe(true)
    expect(registry.pushTokens()).toEqual(['fcm-token-abc'])
  })

  it('rejects a signature from a different key', () => {
    // The core property: possession of an approved device key is what
    // authorises registration.
    const registry = makeRegistry()
    const forged = signedRegistration({ deviceId: identity.deviceId }, other)
    // Signed by `other` but claiming `identity`'s id — caught by the id check.
    expect(registry.register(forged)).toMatchObject({ ok: false, reason: 'id-mismatch' })
    expect(registry.pushTokens()).toEqual([])
  })

  it('rejects a tampered push token', () => {
    // The token is bound into the signature, so swapping it invalidates it —
    // otherwise an interceptor could redirect a victim's notifications.
    const registry = makeRegistry()
    const request = signedRegistration()
    const result = registry.register({ ...request, pushToken: 'attacker-token' })
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' })
  })

  it('rejects a public key that does not derive to the claimed id', () => {
    const registry = makeRegistry()
    const request = signedRegistration()
    const result = registry.register({ ...request, publicKey: other.publicKeyB64Url })
    expect(result).toMatchObject({ ok: false, reason: 'id-mismatch' })
  })

  it('rejects a stale registration in both directions', () => {
    // Without a freshness window a captured registration replays forever.
    const registry = makeRegistry()
    expect(
      registry.register(signedRegistration({ signedAt: NOW - REGISTRATION_SKEW_MS - 1 })),
    ).toMatchObject({ ok: false, reason: 'stale' })
    expect(
      registry.register(signedRegistration({ signedAt: NOW + REGISTRATION_SKEW_MS + 1 })),
    ).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('accepts skew inside the window', () => {
    const registry = makeRegistry()
    expect(registry.register(signedRegistration({ signedAt: NOW - REGISTRATION_SKEW_MS })).ok).toBe(
      true,
    )
  })

  it('replaces the row for a device rather than accumulating tokens', () => {
    // A reinstall mints a new push token for the same device; keeping both
    // means every notification arrives twice.
    const registry = makeRegistry()
    registry.register(signedRegistration({ pushToken: 'token-1' }))
    registry.register(signedRegistration({ pushToken: 'token-2' }))
    expect(registry.pushTokens()).toEqual(['token-2'])
  })

  it('keeps distinct devices separate', () => {
    const registry = makeRegistry()
    registry.register(signedRegistration({ pushToken: 'a' }))
    registry.register(signedRegistration({ pushToken: 'b' }, other))
    expect(registry.pushTokens().sort()).toEqual(['a', 'b'])
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an empty object', {}],
    ['a missing signature', { deviceId: 'a', publicKey: 'b', pushToken: 'c', signedAt: NOW }],
    ['an empty deviceId', { deviceId: '', publicKey: 'b', pushToken: 'c', signedAt: NOW, signature: 'd' }],
    ['a non-numeric signedAt', { deviceId: 'a', publicKey: 'b', pushToken: 'c', signedAt: 'x', signature: 'd' }],
  ])('never throws on %s', (_label, input) => {
    const registry = makeRegistry()
    expect(() => registry.register(input)).not.toThrow()
    expect(registry.register(input).ok).toBe(false)
  })

  it('rejects an unparseable public key without throwing', () => {
    const registry = makeRegistry()
    const result = registry.register({ ...signedRegistration(), publicKey: '!!!not-base64!!!' })
    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('unregister and dropToken', () => {
  it('removes a device on logout', () => {
    const registry = makeRegistry()
    registry.register(signedRegistration())
    expect(registry.unregister(identity.deviceId)).toBe(true)
    expect(registry.pushTokens()).toEqual([])
  })

  it('reports when there was nothing to remove', () => {
    expect(makeRegistry().unregister('unknown')).toBe(false)
  })

  it('drops a token FCM reported dead', () => {
    // 404/403 from FCM means the token is gone; retrying it forever wastes
    // every future send.
    const registry = makeRegistry()
    registry.register(signedRegistration({ pushToken: 'dead-token' }))
    registry.dropToken('dead-token')
    expect(registry.pushTokens()).toEqual([])
  })
})

describe('buildRegistrationPayload', () => {
  it('is positional and versioned', () => {
    expect(
      buildRegistrationPayload({ deviceId: 'abc', pushToken: 'tok', signedAtMs: 42 }),
    ).toBe('register|v1|abc|tok|42')
  })

  it('changes when any field changes', () => {
    const base = { deviceId: 'abc', pushToken: 'tok', signedAtMs: 42 }
    const variants = [
      { ...base, deviceId: 'abd' },
      { ...base, pushToken: 'tol' },
      { ...base, signedAtMs: 43 },
    ]
    const seen = new Set(variants.map(buildRegistrationPayload))
    expect(seen.size).toBe(3)
    expect(seen.has(buildRegistrationPayload(base))).toBe(false)
  })
})

/** Guards the guard: the signing helper we test against is the real one. */
describe('test harness', () => {
  it('uses the same signer the app uses', () => {
    const device = signConnectChallenge({
      identity,
      nonce: 'n',
      clientId: 'openclaw-android',
      clientMode: 'ui',
      role: 'operator',
      scopes: ['operator.read'],
      token: null,
      platform: 'android',
      signedAtMs: NOW,
    })
    expect(device.publicKey).toBe(identity.publicKeyB64Url)
  })
})
