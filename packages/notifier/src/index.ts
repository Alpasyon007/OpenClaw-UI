/**
 * `@openclaw/notifier` — gateway events to push notifications.
 *
 * Exists because the gateway cannot notify an Android device by any path: its
 * APNs sender is gated on iOS, and its Web Push sender has no event triggers.
 * This is a plain operator client doing the fan-out, so it needs no gateway
 * changes and can be deployed next to it.
 */
export * from './payload'
export * from './notifier'
export * from './fcm'
export * from './registry'
