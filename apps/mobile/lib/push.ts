/**
 * Push registration.
 *
 * The gateway has no surface for a native FCM token, so the app registers with
 * the notifier service instead. It authenticates that registration with the
 * *same* Ed25519 device key it uses to connect — no second credential, and
 * nothing sensitive travels: the notifier verifies the signature and checks
 * that `sha256(publicKey)` equals the claimed device id.
 *
 * Every step here can legitimately fail on a given device — no Play Services,
 * permission refused, no Firebase config in the build — so each returns a named
 * reason rather than throwing. "Push is unavailable" is a normal state to
 * render, not an error to swallow.
 */
import { Platform } from 'react-native'
import * as ed from '@noble/ed25519'
import {
  base64UrlEncode,
  utf8Bytes,
  type DeviceIdentity,
} from '@openclaw/gateway-client'
import { buildRegistrationPayload } from '@openclaw/protocol'

export type PushState =
  | { status: 'unsupported'; detail: string }
  | { status: 'denied'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'registered'; token: string }

/**
 * Obtain the device's FCM token.
 *
 * `getDevicePushTokenAsync` returns the raw FCM token, which is what a
 * self-hosted sender needs. `getExpoPushTokenAsync` would return an
 * Expo-brokered token instead, requiring their relay to hold it — deliberately
 * avoided, since the whole point of running our own notifier is not to put a
 * third party in the path.
 */
/**
 * Load the notification modules lazily.
 *
 * `expo-notifications` throws **at import** when its native module is absent —
 * which happens on any build predating its installation, and on Expo Go. A
 * top-level import therefore crashes the entire app on startup rather than
 * disabling one feature, and no amount of try/catch inside the functions helps,
 * because the failure happens before they are ever called.
 */
async function loadNotificationModules(): Promise<{
  Notifications: typeof import('expo-notifications')
  Device: typeof import('expo-device')
} | null> {
  try {
    const [Notifications, Device] = await Promise.all([
      import('expo-notifications'),
      import('expo-device'),
    ])
    return { Notifications, Device }
  } catch {
    return null
  }
}

export async function acquirePushToken(): Promise<PushState> {
  const modules = await loadNotificationModules()
  if (!modules) {
    return {
      status: 'unavailable',
      detail:
        'Notification modules are not in this build. Rebuild the app after adding expo-notifications.',
    }
  }
  const { Notifications, Device } = modules

  if (!Device.isDevice) {
    // An emulator without Play Services cannot receive FCM at all. Saying so is
    // more useful than a generic failure.
    return {
      status: 'unsupported',
      detail: 'Push needs a physical device with Google Play services.',
    }
  }

  try {
    // `NotificationPermissionsStatus` extends `PermissionResponse` from the
    // `expo` package, which does not resolve in this workspace — so the fields
    // are read through an explicit local shape rather than suppressing the
    // error. The runtime values are unchanged; only the typing is restated.
    type PermissionLike = { granted?: boolean; canAskAgain?: boolean; status?: string }
    const asPermission = (value: unknown): PermissionLike => (value ?? {}) as PermissionLike

    const existing = asPermission(await Notifications.getPermissionsAsync())
    let granted = existing.granted === true || existing.status === 'granted'

    if (!granted && existing.canAskAgain !== false) {
      const requested = asPermission(await Notifications.requestPermissionsAsync())
      granted = requested.granted === true || requested.status === 'granted'
    }
    if (!granted) {
      return { status: 'denied', detail: 'Notification permission was not granted.' }
    }

    const token = await Notifications.getDevicePushTokenAsync()
    if (typeof token.data !== 'string' || !token.data) {
      return { status: 'unavailable', detail: 'No push token was issued.' }
    }
    return { status: 'registered', token: token.data }
  } catch (err) {
    // Overwhelmingly this is a build with no google-services.json, which is a
    // configuration gap rather than a runtime fault.
    return {
      status: 'unavailable',
      detail: `Push unavailable: ${String(err)}. A Firebase config is required for FCM.`,
    }
  }
}

export interface RegistrationOutcome {
  ok: boolean
  detail: string
}

/**
 * Register the push token with the notifier.
 *
 * The signature covers the token itself, so an interceptor cannot substitute
 * its own and redirect this device's notifications.
 */
export async function registerPushToken(args: {
  notifierUrl: string
  identity: DeviceIdentity
  pushToken: string
  now?: () => number
}): Promise<RegistrationOutcome> {
  const signedAt = (args.now ?? Date.now)()
  const payload = buildRegistrationPayload({
    deviceId: args.identity.deviceId,
    pushToken: args.pushToken,
    signedAtMs: signedAt,
  })
  const signature = base64UrlEncode(ed.sign(utf8Bytes(payload), args.identity.privateKey))

  try {
    const response = await fetch(`${args.notifierUrl.replace(/\/+$/, '')}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: args.identity.deviceId,
        publicKey: args.identity.publicKeyB64Url,
        pushToken: args.pushToken,
        signedAt,
        signature,
        platform: Platform.OS,
      }),
    })

    if (!response.ok) {
      return { ok: false, detail: `Notifier rejected the registration (${response.status}).` }
    }
    return { ok: true, detail: 'Registered for push.' }
  } catch (err) {
    return { ok: false, detail: `Could not reach the notifier: ${String(err)}` }
  }
}

/**
 * How a notification maps back to a screen.
 *
 * Payloads carry ids only, so the app resolves the actual content over its own
 * authenticated socket after unlocking — which is what keeps transcript text
 * off the lock screen.
 */
export function deepLinkForNotification(data: Record<string, unknown>): string | null {
  const kind = typeof data.kind === 'string' ? data.kind : ''
  const sessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : ''

  if (kind === 'approval') return sessionKey ? `/session/${encodeURIComponent(sessionKey)}` : '/'
  if (kind === 'run-complete' || kind === 'run-failed') {
    return sessionKey ? `/session/${encodeURIComponent(sessionKey)}` : '/'
  }
  return null
}
