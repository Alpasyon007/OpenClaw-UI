import { describe, it, expect } from 'vitest'
import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
} from 'node:crypto'
import { buildDeviceAuthPayloadV3 } from '@openclaw/protocol'
import {
  generateDeviceIdentity,
  deviceIdentityFromPrivateKey,
  deriveDeviceId,
  isConsistentIdentity,
  signConnectChallenge,
  verifyDeviceSignature,
  toPublicIdentity,
} from './device-identity'
import { base64UrlDecode, base64UrlEncode } from './base64url'

const SEED = new Uint8Array(32).fill(7)

const signArgs = {
  nonce: 'ab53d2ee-0f6b-4a1e-9c2e-2f0f3f9d1111',
  clientId: 'openclaw-android',
  clientMode: 'ui',
  role: 'operator' as const,
  scopes: ['operator.read', 'operator.write', 'operator.approvals'],
  token: 'device-token',
  platform: 'android',
  deviceFamily: 'Pixel',
  signedAtMs: 1_700_000_000_000,
}

describe('device identity derivation', () => {
  it('derives a 64-character lowercase hex device id', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the id as sha256 of the RAW public key', () => {
    // Independently computed with node:crypto. Hashing SPKI DER instead of the
    // raw 32 bytes yields a self-consistent id that the server still rejects,
    // so this must be pinned against an outside implementation.
    const identity = deviceIdentityFromPrivateKey(SEED)
    const raw = base64UrlDecode(identity.publicKeyB64Url)
    const expected = createHash('sha256').update(raw).digest('hex')
    expect(identity.deviceId).toBe(expected)
  })

  it('encodes the public key as exactly 32 raw bytes', () => {
    // The server rebuilds an SPKI key by concatenating a fixed DER prefix with
    // whatever these bytes decode to. Anything but the raw 32 produces a key
    // that fails verification rather than an obvious decode error.
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(base64UrlDecode(identity.publicKeyB64Url)).toHaveLength(32)
  })

  it('emits unpadded base64url for the public key', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(identity.publicKeyB64Url).not.toContain('=')
    expect(identity.publicKeyB64Url).not.toContain('+')
    expect(identity.publicKeyB64Url).not.toContain('/')
  })

  it('is deterministic for a given seed', () => {
    expect(deviceIdentityFromPrivateKey(SEED).deviceId).toBe(
      deviceIdentityFromPrivateKey(SEED).deviceId,
    )
  })

  it('generates distinct identities', () => {
    expect(generateDeviceIdentity().deviceId).not.toBe(generateDeviceIdentity().deviceId)
  })

  it('rejects a wrong-sized private key rather than deriving a bogus identity', () => {
    expect(() => deviceIdentityFromPrivateKey(new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => deviceIdentityFromPrivateKey(new Uint8Array(0))).toThrow(/32 bytes/)
  })

  it('keeps the private key out of the public projection', () => {
    const pub = toPublicIdentity(deviceIdentityFromPrivateKey(SEED))
    expect(Object.keys(pub).sort()).toEqual(['deviceId', 'publicKeyB64Url'])
    expect(JSON.stringify(pub)).not.toContain('privateKey')
  })
})

describe('deriveDeviceId / isConsistentIdentity', () => {
  it('recomputes the id from the wire value', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(deriveDeviceId(identity.publicKeyB64Url)).toBe(identity.deviceId)
    expect(isConsistentIdentity(identity)).toBe(true)
  })

  it('detects a mismatched stored identity', () => {
    // A corrupted keystore entry otherwise surfaces as an opaque auth rejection
    // — and each attempt burns the gateway's auth rate limit.
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(isConsistentIdentity({ ...identity, deviceId: 'f'.repeat(64) })).toBe(false)
  })

  it('never throws on malformed stored material', () => {
    expect(isConsistentIdentity({ deviceId: 'x', publicKeyB64Url: 'not!valid!' })).toBe(false)
    expect(isConsistentIdentity({ deviceId: 'x', publicKeyB64Url: '' })).toBe(false)
  })

  it('rejects a public key of the wrong length', () => {
    expect(() => deriveDeviceId(base64UrlEncode(new Uint8Array(16)))).toThrow(/32 bytes/)
  })
})

describe('signConnectChallenge', () => {
  it('round-trips against our own verifier', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const device = signConnectChallenge({ identity, ...signArgs })
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: signArgs.clientId,
      clientMode: signArgs.clientMode,
      role: signArgs.role,
      scopes: signArgs.scopes,
      signedAtMs: signArgs.signedAtMs,
      token: signArgs.token,
      nonce: signArgs.nonce,
      platform: signArgs.platform,
      deviceFamily: signArgs.deviceFamily,
    })
    expect(verifyDeviceSignature(device.publicKey, payload, device.signature)).toBe(true)
  })

  it('produces a signature node:crypto accepts', () => {
    // The gateway verifies with node:crypto's Ed25519. Checking our signature
    // against the same implementation — rather than only against our own
    // verifier — is what proves the encoding is right, since a self-consistent
    // but non-standard scheme would pass a pure round-trip test.
    const identity = deviceIdentityFromPrivateKey(SEED)
    const device = signConnectChallenge({ identity, ...signArgs })
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: signArgs.clientId,
      clientMode: signArgs.clientMode,
      role: signArgs.role,
      scopes: signArgs.scopes,
      signedAtMs: signArgs.signedAtMs,
      token: signArgs.token,
      nonce: signArgs.nonce,
      platform: signArgs.platform,
      deviceFamily: signArgs.deviceFamily,
    })

    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(base64UrlDecode(device.publicKey)),
    ])
    const key = createPublicKey({ key: spki, type: 'spki', format: 'der' })

    expect(
      nodeVerify(
        null,
        Buffer.from(payload, 'utf8'),
        key,
        Buffer.from(base64UrlDecode(device.signature)),
      ),
    ).toBe(true)
  })

  it('interoperates with a node:crypto-generated key', () => {
    // Proves the seed we hand @noble matches what node:crypto calls a private
    // key — the two libraries disagreeing on seed-vs-expanded-key would be
    // invisible in a self-round-trip.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
    const seed = new Uint8Array(pkcs8.subarray(pkcs8.length - 32))

    const identity = deviceIdentityFromPrivateKey(seed)
    const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    expect(Buffer.from(base64UrlDecode(identity.publicKeyB64Url)).equals(rawPublic)).toBe(true)

    const payload = 'v3|test|payload'
    const nodeSig = nodeSign(null, Buffer.from(payload, 'utf8'), privateKey)
    expect(verifyDeviceSignature(identity.publicKeyB64Url, payload, base64UrlEncode(nodeSig))).toBe(
      true,
    )
  })

  it('echoes the nonce and id into the device object', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const device = signConnectChallenge({ identity, ...signArgs })
    expect(device.id).toBe(identity.deviceId)
    expect(device.publicKey).toBe(identity.publicKeyB64Url)
    expect(device.nonce).toBe(signArgs.nonce)
    expect(device.signedAt).toBe(signArgs.signedAtMs)
  })

  it('emits exactly the five fields the server schema allows', () => {
    // `device` is additionalProperties:false — an extra key fails schema
    // validation before the signature is even considered.
    const device = signConnectChallenge({ identity: deviceIdentityFromPrivateKey(SEED), ...signArgs })
    expect(Object.keys(device).sort()).toEqual(['id', 'nonce', 'publicKey', 'signature', 'signedAt'])
  })

  it('trims the nonce, matching the server', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const padded = signConnectChallenge({ identity, ...signArgs, nonce: `  ${signArgs.nonce}  ` })
    const plain = signConnectChallenge({ identity, ...signArgs })
    expect(padded.nonce).toBe(signArgs.nonce)
    expect(padded.signature).toBe(plain.signature)
  })

  it('refuses to sign an empty nonce', () => {
    // Signing before `connect.challenge` arrives is the mistake this guards.
    const identity = deviceIdentityFromPrivateKey(SEED)
    expect(() => signConnectChallenge({ identity, ...signArgs, nonce: '   ' })).toThrow(/nonce/)
  })

  it('changes the signature when scope ORDER changes', () => {
    // The server joins the received array unsorted, so order is part of the
    // signed message. If this ever stops being true, signing a sorted copy
    // would become safe — and this test is how we would find out.
    const identity = deviceIdentityFromPrivateKey(SEED)
    const a = signConnectChallenge({ identity, ...signArgs, scopes: ['operator.read', 'operator.write'] })
    const b = signConnectChallenge({ identity, ...signArgs, scopes: ['operator.write', 'operator.read'] })
    expect(a.signature).not.toBe(b.signature)
  })

  it.each([
    ['token', { token: 'other' }],
    ['platform', { platform: 'linux' }],
    ['deviceFamily', { deviceFamily: 'Nexus' }],
    ['clientId', { clientId: 'openclaw-ios' }],
    ['clientMode', { clientMode: 'cli' }],
    ['nonce', { nonce: 'a-different-nonce' }],
    ['signedAtMs', { signedAtMs: signArgs.signedAtMs + 1 }],
  ])('changes the signature when %s changes', (_label, override) => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const a = signConnectChallenge({ identity, ...signArgs })
    const b = signConnectChallenge({ identity, ...signArgs, ...override })
    expect(a.signature).not.toBe(b.signature)
  })

  it('treats platform case-insensitively, since the payload normalizes it', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const lower = signConnectChallenge({ identity, ...signArgs, platform: 'android' })
    const upper = signConnectChallenge({ identity, ...signArgs, platform: 'ANDROID' })
    expect(lower.signature).toBe(upper.signature)
  })
})

describe('verifyDeviceSignature', () => {
  it('rejects a tampered payload', () => {
    const identity = deviceIdentityFromPrivateKey(SEED)
    const device = signConnectChallenge({ identity, ...signArgs })
    expect(verifyDeviceSignature(device.publicKey, 'v3|tampered', device.signature)).toBe(false)
  })

  it('never throws on malformed input', () => {
    expect(verifyDeviceSignature('!!!', 'payload', '!!!')).toBe(false)
    expect(verifyDeviceSignature('', '', '')).toBe(false)
  })
})
