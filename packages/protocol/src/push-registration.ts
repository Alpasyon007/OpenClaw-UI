/**
 * The app↔notifier push-registration contract.
 *
 * Lives here rather than in `@openclaw/notifier` because both sides need it and
 * only one of them can load the other: the notifier is a Node service that
 * imports `node:crypto` for FCM's service-account JWT, and pulling that into
 * the app makes the Metro bundle fail to resolve. Keeping the shared half in
 * this package — which is dependency-free and Hermes-safe by construction —
 * means the phone never reaches for server code at all.
 */

/**
 * The string both sides sign and verify.
 *
 * Positional and versioned, mirroring the gateway's own device-auth payload.
 * The push token is bound in deliberately: without it an interceptor could
 * swap the token and redirect a victim's notifications to itself.
 */
export function buildRegistrationPayload(input: {
  deviceId: string
  pushToken: string
  signedAtMs: number
}): string {
  return ['register', 'v1', input.deviceId, input.pushToken, String(input.signedAtMs)].join('|')
}

/**
 * How far a registration's clock may drift, in either direction.
 *
 * Matches the gateway's own 120s device-signature window. Without a freshness
 * bound a captured registration replays forever.
 */
export const REGISTRATION_SKEW_MS = 120_000
