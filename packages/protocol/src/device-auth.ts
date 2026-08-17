/**
 * The device-auth signed payload.
 *
 * A client proves possession of its device key by signing a string the server
 * reconstructs independently from the `connect` params it received. If the two
 * strings differ by a single byte the signature fails and the gateway zeroes
 * the client's scopes — the handshake still *succeeds*, and every subsequent
 * call fails with `missing scope`. That failure mode is why this module exists
 * separately from the signing code: the payload is pure string construction and
 * can be pinned by tests without any crypto in the way.
 *
 * The format is positional and `|`-joined. It is not JSON, so there is no key
 * ordering to canonicalise — but there is *array* ordering, and the server does
 * not sort `scopes` before joining them. Sign the same array you send.
 */

/**
 * Tolerated clock difference between client and gateway, in either direction.
 *
 * A device whose clock is out by more than this is rejected with
 * `device-signature-stale`, which reads like a credential problem rather than a
 * time problem — worth surfacing distinctly in the UI.
 */
export const DEVICE_SIGNATURE_SKEW_MS = 120_000

/**
 * ASCII-only lowercasing after trim.
 *
 * Deliberately not `toLowerCase()`. The server shifts `A-Z` by 0x20 and leaves
 * every other code point alone, so a locale-aware lowercase would disagree on
 * non-ASCII input — the Turkish dotless-i being the classic case. Reproducing
 * the server's exact transform matters more than it being the "right" one.
 */
export function normalizeDeviceMetadataForAuth(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32))
}

/**
 * Which credential gets bound into the signature.
 *
 * Precedence is the server's, and a client that signs a different one than it
 * sends fails verification. In practice: sign `bootstrapToken` during setup-code
 * enrollment, and the stored device `token` on every connect after that.
 */
export function resolveSignatureToken(auth?: {
  token?: string
  deviceToken?: string
  bootstrapToken?: string
}): string | null {
  return auth?.token ?? auth?.deviceToken ?? auth?.bootstrapToken ?? null
}

export interface DeviceAuthPayloadInput {
  deviceId: string
  clientId: string
  clientMode: string
  role: 'operator' | 'node'
  /** Verbatim — the server joins the received array without sorting or deduping. */
  scopes: readonly string[]
  signedAtMs: number
  token: string | null
  /** Trimmed value from the server's `connect.challenge`. */
  nonce: string
}

export interface DeviceAuthPayloadV3Input extends DeviceAuthPayloadInput {
  /** From `connect.params.client.platform`, not from the device object. */
  platform: string
  /** From `connect.params.client.deviceFamily`. */
  deviceFamily?: string
}

/** Current format. Prefer this; v2 exists only for older gateways. */
export function buildDeviceAuthPayloadV3(p: DeviceAuthPayloadV3Input): string {
  return [
    'v3',
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(','),
    String(p.signedAtMs),
    p.token ?? '',
    p.nonce,
    normalizeDeviceMetadataForAuth(p.platform),
    normalizeDeviceMetadataForAuth(p.deviceFamily),
  ].join('|')
}

/** v3 minus `platform` and `deviceFamily`, tagged `v2`. */
export function buildDeviceAuthPayloadV2(p: DeviceAuthPayloadInput): string {
  return [
    'v2',
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(','),
    String(p.signedAtMs),
    p.token ?? '',
    p.nonce,
  ].join('|')
}

/** Whether a `signedAt` would still be inside the server's acceptance window. */
export function isSignatureFresh(signedAtMs: number, now: number): boolean {
  return Number.isFinite(signedAtMs) && Math.abs(now - signedAtMs) <= DEVICE_SIGNATURE_SKEW_MS
}
