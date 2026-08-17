/**
 * The connect handshake.
 *
 * Three things about this sequence are easy to get wrong and each fails in a way
 * that does not look like the actual cause:
 *
 *  1. **The server speaks first.** It sends a `connect.challenge` event carrying
 *     a nonce; the client's first frame must be a `connect` request that signs
 *     that nonce. Sending `connect` optimistically on socket open races the
 *     challenge and produces a signature over a nonce the server never issued.
 *
 *  2. **Omitting `device` does not mean "no device identity" — it means "no
 *     scopes".** The gateway zeroes the granted scope set rather than refusing
 *     the connection, so the handshake succeeds and then every useful call fails
 *     with `missing scope`. That reads as an authorization bug rather than a
 *     malformed handshake.
 *
 *  3. **`PAIRING_REQUIRED` and `UNAVAILABLE` are not failures.** The first means
 *     a human has to approve this device once; the second means the gateway is
 *     still booting its sidecars. Both are retryable and both arrive on the path
 *     where a client would normally give up.
 */
import { z } from 'zod'
import { ErrorShapeSchema } from './frames'

// ─── Roles and scopes ───

export const ROLES = ['operator', 'node'] as const
export type Role = (typeof ROLES)[number]

export const SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.pairing',
  'operator.approvals',
  'operator.talk.secrets',
] as const

export type Scope = (typeof SCOPES)[number]

/**
 * What a companion client asks for, and deliberately no more.
 *
 * `operator.read` carries the broadcast `chat` event stream, `operator.write`
 * allows `chat.send`, and `operator.approvals` is what gates both the
 * `exec.approval.requested` event and `exec.approval.resolve`.
 *
 * `operator.admin` is excluded on purpose. It satisfies every other
 * `operator.*` scope and unlocks config mutation, updates and terminal access,
 * and asking for it escalates the pairing prompt a human has to approve into a
 * far more alarming one. A phone does not need it.
 */
export const COMPANION_SCOPES: readonly Scope[] = [
  'operator.read',
  'operator.write',
  'operator.approvals',
]

// ─── The challenge ───

export const ConnectChallengePayloadSchema = z.object({
  nonce: z.string().min(1),
  ts: z.number().optional(),
})

export type ConnectChallengePayload = z.infer<typeof ConnectChallengePayloadSchema>

export const CONNECT_CHALLENGE_EVENT = 'connect.challenge'

// ─── The request ───

/**
 * Device identity. Every field is bound into the signed payload, so a value that
 * disagrees with what was signed invalidates the signature — these are not
 * free-form metadata.
 */
export const ConnectDeviceSchema = z.object({
  /** Fingerprint of the public key. */
  id: z.string().min(1),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  signedAt: z.number(),
  /** Echoed from the server's challenge. */
  nonce: z.string().min(1),
})

export type ConnectDevice = z.infer<typeof ConnectDeviceSchema>

/**
 * Credential material.
 *
 * Resolution order on the client side is `password` (always forwarded when set,
 * it is orthogonal to the rest), then `token`, then `bootstrapToken` — the last
 * only when nothing else resolved. In practice a companion app sends
 * `bootstrapToken` exactly once, during setup-code enrollment, and a stored
 * per-device `token` on every connect thereafter.
 */
export const ConnectAuthSchema = z.object({
  token: z.string().optional(),
  password: z.string().optional(),
  bootstrapToken: z.string().optional(),
})

export type ConnectAuth = z.infer<typeof ConnectAuthSchema>

/**
 * Closed enum, server-side. A value outside it is rejected before the signature
 * is even checked, so there is no point being creative here.
 */
export const GATEWAY_CLIENT_IDS = [
  'webchat-ui',
  'openclaw-control-ui',
  'openclaw-tui',
  'webchat',
  'cli',
  'gateway-client',
  'openclaw-macos',
  'openclaw-ios',
  'openclaw-android',
  'node-host',
  'test',
  'fingerprint',
  'openclaw-probe',
] as const

export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[number]

/** Also a closed enum. An operator UI connects as `ui`. */
export const CLIENT_MODES = ['webchat', 'cli', 'ui', 'backend', 'node', 'probe', 'test'] as const

export type ClientMode = (typeof CLIENT_MODES)[number]

/**
 * `client` is `additionalProperties: false` on the server — an extra field
 * fails schema validation outright rather than being ignored.
 *
 * `platform` and `deviceFamily` look like telemetry but are **bound into the v3
 * device-auth signature**. Changing either after pairing also re-pins the
 * device and forces re-approval, so they are not free to vary between
 * connections.
 */
export const ConnectClientSchema = z.object({
  id: z.enum(GATEWAY_CLIENT_IDS),
  displayName: z.string().min(1).optional(),
  version: z.string().min(1),
  platform: z.string().min(1),
  deviceFamily: z.string().min(1).optional(),
  modelIdentifier: z.string().min(1).optional(),
  mode: z.enum(CLIENT_MODES),
  instanceId: z.string().min(1).optional(),
})

export type ConnectClient = z.infer<typeof ConnectClientSchema>

export const ConnectParamsSchema = z.object({
  minProtocol: z.number(),
  maxProtocol: z.number(),
  client: ConnectClientSchema,
  role: z.enum(ROLES),
  scopes: z.array(z.string()),
  device: ConnectDeviceSchema.optional(),
  auth: ConnectAuthSchema.optional(),
  caps: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  permissions: z.record(z.unknown()).optional(),
  locale: z.string().optional(),
  userAgent: z.string().optional(),
})

export type ConnectParams = z.infer<typeof ConnectParamsSchema>

// ─── The response ───

/**
 * A minted per-device credential.
 *
 * The setup-code bootstrap returns more than one: a `role: "node"` token plus a
 * bounded `role: "operator"` token. Persist whichever matches the role this
 * client connects as, and reuse the *granted* scope set on the next connect —
 * re-declaring a narrower set opens a fresh pending upgrade request rather than
 * quietly reconnecting.
 */
export const DeviceTokenGrantSchema = z.object({
  deviceToken: z.string(),
  role: z.enum(ROLES),
  scopes: z.array(z.string()),
})

export type DeviceTokenGrant = z.infer<typeof DeviceTokenGrantSchema>

/**
 * Advertised capabilities.
 *
 * Conservative and knowingly incomplete — several real methods are omitted from
 * discovery. Feature-detect optimistically and treat an unknown-method error as
 * "not supported here"; gating a call on absence from this list will disable
 * features that actually work.
 */
export const HelloFeaturesSchema = z.object({
  methods: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
})

export const HelloPolicySchema = z.object({
  maxPayload: z.number().optional(),
  maxBufferedBytes: z.number().optional(),
  tickIntervalMs: z.number().optional(),
})

export const HelloOkSchema = z.object({
  type: z.literal('hello-ok'),
  protocol: z.number(),
  server: z.object({ version: z.string().optional(), connId: z.string().optional() }).optional(),
  features: HelloFeaturesSchema.optional(),
  auth: z
    .object({
      role: z.enum(ROLES).optional(),
      scopes: z.array(z.string()).default([]),
      deviceToken: z.string().optional(),
      deviceTokens: z.array(DeviceTokenGrantSchema).optional(),
    })
    .optional(),
  policy: HelloPolicySchema.optional(),
  /**
   * Schema-required by the gateway but undocumented, and its contents are not
   * needed to operate. Carried through unparsed rather than guessed at.
   */
  snapshot: z.unknown().optional(),
})

export type HelloOk = z.infer<typeof HelloOkSchema>

// ─── Retryable handshake outcomes ───

export const PAIRING_REQUIRED = 'PAIRING_REQUIRED'

/**
 * Why the gateway wants a human to approve this device.
 *
 * The desktop app matches these by scraping the human-readable message with
 * `/pairing required|scope upgrade|missing scope/i`, which catches `not-paired`
 * and `scope-upgrade` but silently misses `role-upgrade` and `metadata-upgrade`.
 * `details.code` plus `details.reason` is the stable contract; use it.
 */
export const PAIRING_REASONS = [
  'not-paired',
  'role-upgrade',
  'scope-upgrade',
  'metadata-upgrade',
] as const

export type PairingReason = (typeof PAIRING_REASONS)[number]

/** The gateway is up but its sidecars are still starting. */
export const STARTUP_SIDECARS = 'startup-sidecars'

export type ConnectRejection =
  | { kind: 'pairing-required'; reason: PairingReason | null; retryAfterMs: number | null }
  | { kind: 'unavailable'; reason: string | null; retryAfterMs: number | null }
  | { kind: 'protocol-mismatch'; message: string }
  | { kind: 'auth'; code: string; message: string; recommendedNextStep: string | null }
  | { kind: 'unknown'; code: string; message: string }

/**
 * Classify a failed `connect`.
 *
 * The distinction that matters to a caller is not the specific code but whether
 * to keep retrying with the same credential, swap credentials, or stop and tell
 * the user something. Everything unrecognised falls through to `unknown`, which
 * callers treat as fatal — the safe default, since retrying an error we do not
 * understand is how a client ends up hammering the auth rate limiter.
 */
export function classifyConnectError(error: unknown): ConnectRejection {
  const parsed = ErrorShapeSchema.safeParse(error)
  if (!parsed.success) {
    return { kind: 'unknown', code: 'UNPARSEABLE', message: 'gateway sent an unreadable error' }
  }

  const err = parsed.data
  const details = err.details ?? {}
  const detailCode = typeof details.code === 'string' ? details.code : null
  const reason = typeof details.reason === 'string' ? details.reason : null
  const retryAfterMs = typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null
  const nextStep =
    typeof details.recommendedNextStep === 'string' ? details.recommendedNextStep : null

  if (detailCode === PAIRING_REQUIRED) {
    return {
      kind: 'pairing-required',
      reason: (PAIRING_REASONS as readonly string[]).includes(reason ?? '')
        ? (reason as PairingReason)
        : null,
      retryAfterMs,
    }
  }

  if (err.code === 'UNAVAILABLE') {
    return { kind: 'unavailable', reason, retryAfterMs }
  }

  if (detailCode === 'PROTOCOL_MISMATCH' || detailCode === 'CLIENT_VERSION_MISMATCH') {
    return { kind: 'protocol-mismatch', message: err.message }
  }

  if (detailCode?.startsWith('AUTH_') || detailCode?.startsWith('DEVICE_')) {
    return { kind: 'auth', code: detailCode, message: err.message, recommendedNextStep: nextStep }
  }

  return { kind: 'unknown', code: err.code, message: err.message }
}

/** Whether a rejection is worth another attempt with the credential we already hold. */
export function isRetryableConnectRejection(rejection: ConnectRejection): boolean {
  return rejection.kind === 'pairing-required' || rejection.kind === 'unavailable'
}
