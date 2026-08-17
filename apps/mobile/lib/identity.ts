/**
 * Device identity persistence.
 *
 * The private key is the paired device's credential — possession of it *is* the
 * device. It goes to `expo-secure-store` (Android Keystore / iOS Keychain) and
 * nowhere else: not AsyncStorage, not MMKV, not a log line, not a crash report.
 *
 * SecureStore holds strings, so the 32-byte seed is stored as hex and the public
 * half is re-derived on load rather than stored alongside — one source of truth
 * means a corrupted entry cannot produce a *self-consistent but wrong* identity.
 */
import * as SecureStore from 'expo-secure-store'
import {
  deviceIdentityFromPrivateKey,
  generateDeviceIdentity,
  type DeviceIdentity,
} from '@openclaw/gateway-client'

const KEY = 'openclaw.device.privateKey'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)))

/**
 * Load the stored identity, minting one on first run.
 *
 * A stored value that does not yield a valid key is replaced rather than
 * surfaced as an error — there is nothing a user can do about a corrupted
 * keystore entry, and the recovery is simply to pair again.
 */
export async function loadOrCreateIdentity(): Promise<{
  identity: DeviceIdentity
  created: boolean
}> {
  const stored = await SecureStore.getItemAsync(KEY)
  if (stored) {
    try {
      return { identity: deviceIdentityFromPrivateKey(fromHex(stored)), created: false }
    } catch {
      // Fall through and re-mint.
    }
  }

  const identity = generateDeviceIdentity()
  await SecureStore.setItemAsync(KEY, toHex(identity.privateKey))
  return { identity, created: true }
}

/** Forget this device. The gateway side needs `device.token.revoke` separately. */
export async function clearIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}
