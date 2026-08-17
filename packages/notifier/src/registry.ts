/**
 * Device token registry.
 *
 * The gateway has no surface for registering a native FCM token — `push.web.*`
 * is VAPID Web Push, a different shape entirely — so this service keeps its own
 * registry. The question that matters is how it authenticates a registration.
 *
 * It does **not** invent a shared secret, and it does not accept the gateway
 * token: handing that to every phone would put a tool-execution credential in
 * one more place for no benefit. Instead the app signs its registration with
 * the same Ed25519 device key it already uses to connect, and this module
 * verifies two things:
 *
 *   1. the signature is valid for the supplied public key, and
 *   2. `sha256(publicKey)` equals the claimed `deviceId` — the gateway's own
 *      derivation, so a device cannot register under another's identity.
 *
 * The result is that registering requires possession of a key a human already
 * approved, and stolen registrations cannot be replayed for a different device.
 */
import { verifyDeviceSignature, deriveDeviceId } from '@openclaw/gateway-client'
import { buildRegistrationPayload, REGISTRATION_SKEW_MS } from '@openclaw/protocol'

// Re-exported so notifier consumers need not know where the contract lives.
export { buildRegistrationPayload, REGISTRATION_SKEW_MS }

export interface RegistrationRequest {
  deviceId: string
  publicKey: string
  pushToken: string
  signedAt: number
  signature: string
}

export interface RegisteredDevice {
  deviceId: string
  pushToken: string
  registeredAtMs: number
}

export type RegistrationResult =
  | { ok: true; device: RegisteredDevice }
  | { ok: false; reason: 'malformed' | 'stale' | 'bad-signature' | 'id-mismatch' }

/** Persistence is injected — a file, a KV, or a Map in tests. */
export interface RegistryStore {
  list: () => RegisteredDevice[]
  save: (devices: RegisteredDevice[]) => void
}

export function createMemoryStore(initial: RegisteredDevice[] = []): RegistryStore {
  let devices = [...initial]
  return {
    list: () => [...devices],
    save: (next) => {
      devices = [...next]
    },
  }
}

export class DeviceRegistry {
  constructor(
    private readonly store: RegistryStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Verify and record a registration.
   *
   * Never throws — this sits behind an HTTP handler reachable by anything that
   * can find the port, and an exception there is a denial-of-service rather
   * than a rejection.
   */
  register(request: unknown): RegistrationResult {
    const r = request as Partial<RegistrationRequest> | null
    if (
      !r ||
      typeof r.deviceId !== 'string' ||
      typeof r.publicKey !== 'string' ||
      typeof r.pushToken !== 'string' ||
      typeof r.signature !== 'string' ||
      typeof r.signedAt !== 'number' ||
      !r.deviceId ||
      !r.pushToken
    ) {
      return { ok: false, reason: 'malformed' }
    }

    if (Math.abs(this.now() - r.signedAt) > REGISTRATION_SKEW_MS) {
      return { ok: false, reason: 'stale' }
    }

    // Check the id derives from the key BEFORE verifying the signature: a
    // signature is only meaningful once we know whose key it is.
    let derived: string
    try {
      derived = deriveDeviceId(r.publicKey)
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (derived !== r.deviceId) return { ok: false, reason: 'id-mismatch' }

    const payload = buildRegistrationPayload({
      deviceId: r.deviceId,
      pushToken: r.pushToken,
      signedAtMs: r.signedAt,
    })
    if (!verifyDeviceSignature(r.publicKey, payload, r.signature)) {
      return { ok: false, reason: 'bad-signature' }
    }

    const device: RegisteredDevice = {
      deviceId: r.deviceId,
      pushToken: r.pushToken,
      registeredAtMs: this.now(),
    }

    // One row per device, not per token: a reinstall mints a new push token for
    // the same device, and keeping both means every notification arrives twice
    // until the dead one is reaped.
    const rest = this.store.list().filter((d) => d.deviceId !== device.deviceId)
    this.store.save([...rest, device])
    return { ok: true, device }
  }

  /** Remove a device, e.g. on logout. */
  unregister(deviceId: string): boolean {
    const before = this.store.list()
    const after = before.filter((d) => d.deviceId !== deviceId)
    if (after.length === before.length) return false
    this.store.save(after)
    return true
  }

  /** Drop a token FCM reported as dead (404/403). */
  dropToken(pushToken: string): void {
    this.store.save(this.store.list().filter((d) => d.pushToken !== pushToken))
  }

  /** The callback shape {@link startNotifier} expects. */
  pushTokens(): string[] {
    return this.store.list().map((d) => d.pushToken)
  }

  devices(): RegisteredDevice[] {
    return this.store.list()
  }
}
