/**
 * Device identity — an Ed25519 keypair that proves this installation is the same
 * one a human approved during pairing.
 *
 * The gateway derives the device id from the public key itself, so the id is not
 * a name we choose: it is `sha256(rawPublicKey)` in lowercase hex, and the
 * server recomputes and compares it on every connect. Sending an id that does
 * not match the key is rejected as `device-id-mismatch`.
 *
 * Everything here is deliberately free of Node APIs. `@noble/ed25519` is pure
 * JavaScript, which is what lets the same signing path run in the sidecar, in a
 * browser and under Hermes — a native crypto module would fork this code three
 * ways for no benefit.
 *
 * **React Native callers must import `react-native-get-random-values` once at
 * app entry.** Key generation needs `crypto.getRandomValues`, which Hermes does
 * not provide; without the polyfill {@link generateDeviceIdentity} throws at the
 * point of first use rather than at startup.
 */
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  buildDeviceAuthPayloadV3,
  type ConnectDevice,
  type DeviceAuthPayloadV3Input,
  type Scope,
} from '@openclaw/protocol'
import { base64UrlEncode, base64UrlDecode, utf8Bytes } from './base64url'

/**
 * `@noble/ed25519` v2 ships async APIs that reach for WebCrypto, and sync APIs
 * that need a SHA-512 wired in. WebCrypto's `subtle` is absent or partial under
 * Hermes, so the sync path with an explicit hash is the portable one.
 *
 * Assigned at module load, once. Doing it lazily inside the signing function
 * would re-check on every call for no gain.
 */
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))

/** Raw Ed25519 key sizes, in bytes. Used to reject malformed stored material. */
const PRIVATE_KEY_BYTES = 32
const PUBLIC_KEY_BYTES = 32

export interface DeviceIdentity {
  /** `sha256(rawPublicKey)` as lowercase hex — 64 characters, never truncated. */
  deviceId: string
  /** Raw 32 bytes, unpadded base64url. This is the on-wire `device.publicKey`. */
  publicKeyB64Url: string
  /**
   * The 32-byte Ed25519 seed.
   *
   * Secret. It must reach `expo-secure-store` (Keychain / Android Keystore) and
   * nothing else — never MMKV, never SQLite, never a log line, never a crash
   * report. Possession of this is possession of the paired device.
   */
  privateKey: Uint8Array
}

/** The identity minus its secret. Safe to log, render and persist in the clear. */
export type PublicDeviceIdentity = Omit<DeviceIdentity, 'privateKey'>

/** Strip the secret. Use this at any boundary that is not the keystore. */
export function toPublicIdentity(identity: DeviceIdentity): PublicDeviceIdentity {
  return { deviceId: identity.deviceId, publicKeyB64Url: identity.publicKeyB64Url }
}

/** Derive the full identity from a seed. */
export function deviceIdentityFromPrivateKey(privateKey: Uint8Array): DeviceIdentity {
  if (privateKey.length !== PRIVATE_KEY_BYTES) {
    throw new Error(`device private key must be ${PRIVATE_KEY_BYTES} bytes, got ${privateKey.length}`)
  }
  const publicKey = ed.getPublicKey(privateKey)
  return {
    deviceId: bytesToHex(sha256(publicKey)),
    publicKeyB64Url: base64UrlEncode(publicKey),
    privateKey,
  }
}

/** Mint a brand-new identity. Pair it once, then persist and reuse it forever. */
export function generateDeviceIdentity(): DeviceIdentity {
  return deviceIdentityFromPrivateKey(ed.utils.randomPrivateKey())
}

/**
 * Recompute a device id from an on-wire public key, exactly as the server does.
 *
 * Useful for asserting that a restored identity is internally consistent before
 * spending a connect attempt on it — a corrupted keystore entry otherwise shows
 * up as an opaque auth rejection, and the auth rate limiter is unforgiving
 * (10 attempts per minute, then a five-minute lockout).
 */
export function deriveDeviceId(publicKeyB64Url: string): string {
  const raw = base64UrlDecode(publicKeyB64Url)
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`device public key must decode to ${PUBLIC_KEY_BYTES} bytes, got ${raw.length}`)
  }
  return bytesToHex(sha256(raw))
}

/** Whether a stored identity still hashes to its own id. */
export function isConsistentIdentity(identity: PublicDeviceIdentity): boolean {
  try {
    return deriveDeviceId(identity.publicKeyB64Url) === identity.deviceId
  } catch {
    return false
  }
}

export interface SignChallengeInput {
  identity: DeviceIdentity
  /** From the server's `connect.challenge`, trimmed. */
  nonce: string
  clientId: string
  clientMode: string
  role: 'operator' | 'node'
  /**
   * The exact array that will be sent as `connect.params.scopes`.
   *
   * The server joins what it receives without sorting or deduping, so signing a
   * reordered copy produces a payload that cannot match. Pass the same value to
   * both places — ideally the same reference.
   */
  scopes: readonly Scope[] | readonly string[]
  /** Resolved by the caller via `resolveSignatureToken`. */
  token: string | null
  platform: string
  deviceFamily?: string
  /** Injectable for tests. Defaults to now. */
  signedAtMs?: number
}

/**
 * Sign the server's challenge, producing the `device` object for `connect`.
 *
 * Must be called only *after* `connect.challenge` arrives. Signing a
 * self-invented nonce yields `DEVICE_AUTH_NONCE_MISMATCH`, and because the
 * handshake otherwise looks well-formed that reads as a credential problem
 * rather than a sequencing one.
 */
export function signConnectChallenge(input: SignChallengeInput): ConnectDevice {
  const nonce = input.nonce.trim()
  if (!nonce) throw new Error('cannot sign an empty challenge nonce')

  const signedAt = input.signedAtMs ?? Date.now()
  const payload = buildDeviceAuthPayloadV3({
    deviceId: input.identity.deviceId,
    clientId: input.clientId,
    clientMode: input.clientMode,
    role: input.role,
    scopes: input.scopes,
    signedAtMs: signedAt,
    token: input.token,
    nonce,
    platform: input.platform,
    deviceFamily: input.deviceFamily,
  } satisfies DeviceAuthPayloadV3Input)

  // Pure EdDSA over the raw UTF-8 bytes — not over a digest of them.
  const signature = ed.sign(utf8Bytes(payload), input.identity.privateKey)

  return {
    id: input.identity.deviceId,
    publicKey: input.identity.publicKeyB64Url,
    signature: base64UrlEncode(signature),
    signedAt,
    nonce,
  }
}

/**
 * Verify a signature the way the gateway does.
 *
 * Present so the test suite can assert round-trip correctness against an
 * independent path rather than trusting the signer to check its own work.
 */
export function verifyDeviceSignature(
  publicKeyB64Url: string,
  payload: string,
  signatureB64Url: string,
): boolean {
  try {
    return ed.verify(
      base64UrlDecode(signatureB64Url),
      utf8Bytes(payload),
      base64UrlDecode(publicKeyB64Url),
    )
  } catch {
    return false
  }
}
