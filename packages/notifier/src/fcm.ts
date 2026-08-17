/**
 * FCM HTTP v1 transport.
 *
 * Deliberately minimal and dependency-free: signing a service-account JWT is
 * about forty lines, and `firebase-admin` is a large dependency that mostly
 * provides features this service does not use.
 *
 * Notifications are sent as **data-only** messages. A `notification` block is
 * rendered by the OS before the app sees it, which would mean the payload text
 * is the whole story; data-only lets the app decide what to display after it
 * has resolved the pointer over its own authenticated socket. It also keeps
 * behaviour identical whether the app is foregrounded, backgrounded or killed.
 */
import { createSign } from 'node:crypto'
import type { PushTransport } from './notifier'

export interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
}

/**
 * Token state.
 *
 * `inflight` is what makes concurrent pushes safe. Without it, a burst of
 * notifications arriving on an expired token each starts its own mint, and the
 * last one to resolve overwrites the others — wasting round trips and, worse,
 * potentially caching an older token over a newer one.
 */
interface TokenCache {
  current: CachedToken | null
  inflight: Promise<string> | null
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '')
}

/**
 * Mint an OAuth access token from the service account.
 *
 * Cached with a 60s safety margin — minting on every push would add a round
 * trip to a path that is already latency-sensitive.
 */
function getAccessToken(
  account: FcmServiceAccount,
  cache: TokenCache,
  now: () => number,
): Promise<string> {
  if (cache.current && cache.current.expiresAtMs > now() + 60_000) {
    return Promise.resolve(cache.current.accessToken)
  }
  // Collapse a burst onto one mint. Assigning the promise before awaiting is
  // what makes this atomic — every concurrent caller sees the same one.
  cache.inflight ??= mintAccessToken(account, cache, now).finally(() => {
    cache.inflight = null
  })
  return cache.inflight
}

async function mintAccessToken(
  account: FcmServiceAccount,
  cache: TokenCache,
  now: () => number,
): Promise<string> {
  const issuedAt = Math.floor(now() / 1000)
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }

  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64Url(JSON.stringify(claims))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  const signature = base64Url(signer.sign(account.private_key))
  const assertion = `${header}.${body}.${signature}`

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!response.ok) {
    throw new Error(`FCM token exchange failed with ${response.status}`)
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('FCM token exchange returned no access_token')

  cache.current = {
    accessToken: json.access_token,
    expiresAtMs: now() + (json.expires_in ?? 3600) * 1000,
  }
  return json.access_token
}

export interface FcmTransportOptions {
  account: FcmServiceAccount
  onLog?: (message: string) => void
  now?: () => number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

export function createFcmTransport(options: FcmTransportOptions): PushTransport {
  const { account, onLog = () => {}, now = Date.now, fetchImpl = fetch } = options
  const cache: TokenCache = { current: null, inflight: null }

  return async (notification, deviceToken) => {
    const accessToken = await getAccessToken(account, cache, now)

    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            // Data-only: the app renders it, so the payload stays a pointer.
            data: { ...notification.data, title: notification.title, body: notification.body },
            android: {
              priority: 'HIGH',
              ...(notification.collapseKey ? { collapse_key: notification.collapseKey } : {}),
            },
          },
        }),
      },
    )

    if (response.ok) return true

    // 404 UNREGISTERED and 403 SENDER_ID_MISMATCH mean the token is dead —
    // the caller should stop sending to it rather than retry forever.
    if (response.status === 404 || response.status === 403) {
      onLog(`device token rejected (${response.status}) — drop it`)
      return false
    }

    onLog(`FCM send failed with ${response.status}`)
    return false
  }
}
