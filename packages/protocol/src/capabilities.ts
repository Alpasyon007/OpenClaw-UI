/**
 * Optimistic feature detection.
 *
 * `hello-ok.features.methods` is documented in {@link HelloFeaturesSchema} as
 * conservative and knowingly incomplete — several methods that work are simply
 * absent from it. So gating a call on presence in that list disables features
 * that would have worked, which is the worse failure of the two.
 *
 * The rule this module encodes is therefore: **call it, and learn from the
 * refusal.** A method is assumed available until the gateway says otherwise,
 * and once it has said so the answer is remembered for the lifetime of the
 * connection so the UI can hide the affordance instead of offering a button
 * that fails every time.
 *
 * Pure and socket-free so the policy can be tested without a gateway.
 */
import { GatewayRequestErrorLike } from './frames-errors'

/**
 * Does this error mean "this gateway does not have that method", as opposed to
 * "that method ran and failed"?
 *
 * There is no dedicated error code for it. The gateway answers an unrouted
 * method with `INVALID_REQUEST` and a message naming the method, which is the
 * same code it uses for a method that exists but was sent bad params — so the
 * message has to be read. The patterns below are matched conservatively:
 * misreading a real validation failure as "unsupported" would permanently hide
 * a working feature after one malformed call, which is far harder to diagnose
 * than a visible error.
 */
export function isUnsupportedMethodError(error: unknown): boolean {
  const err = error as GatewayRequestErrorLike | null
  if (!err || typeof err !== 'object') return false

  const code = typeof err.code === 'string' ? err.code : ''
  // A pre-flight scope refusal is not an absent method — the method exists and
  // this device simply may not call it. Conflating them would tell the user to
  // upgrade their gateway when the fix is to re-pair.
  if (code === 'MISSING_SCOPE') return false

  const message = typeof err.message === 'string' ? err.message.toLowerCase() : ''
  if (!message) return false

  return (
    /\bunknown method\b/.test(message) ||
    /\bunsupported method\b/.test(message) ||
    /\bmethod not found\b/.test(message) ||
    /\bno such method\b/.test(message) ||
    /\bnot implemented\b/.test(message) ||
    /\bunroutable\b/.test(message)
  )
}

/**
 * Whether a failed call means "this gateway build is older than this app".
 *
 * Separate from {@link isUnsupportedMethodError} because the two want different
 * copy: an absent method is a gateway that cannot do the thing, a missing scope
 * is a device that was not granted it, and telling a user to upgrade when they
 * need to re-pair sends them down the wrong path entirely.
 */
export function isMissingScopeError(error: unknown): boolean {
  const err = error as GatewayRequestErrorLike | null
  if (!err || typeof err !== 'object') return false
  if (err.code === 'MISSING_SCOPE') return true
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : ''
  return /\bmissing scope\b/.test(message) || /\bscope\b.*\bnot granted\b/.test(message)
}

export type Capability = 'available' | 'unsupported' | 'forbidden'

/**
 * Per-connection memory of what the gateway turned out to support.
 *
 * Deliberately starts empty and optimistic. `hello-ok` is *consulted* rather
 * than trusted: a method the server explicitly advertises is pinned available,
 * but absence from the advertisement proves nothing and leaves the method in
 * the "try it" state.
 */
export class CapabilityCache {
  private readonly known = new Map<string, Capability>()

  constructor(advertised: readonly string[] = []) {
    for (const method of advertised) this.known.set(method, 'available')
  }

  /**
   * What we currently believe. `'available'` for anything not yet disproved —
   * see the module note on why absence is not evidence.
   */
  get(method: string): Capability {
    return this.known.get(method) ?? 'available'
  }

  supports(method: string): boolean {
    return this.get(method) === 'available'
  }

  /** Record what a failure taught us. Returns the classification. */
  learnFromError(method: string, error: unknown): Capability {
    if (isUnsupportedMethodError(error)) {
      this.known.set(method, 'unsupported')
      return 'unsupported'
    }
    if (isMissingScopeError(error)) {
      this.known.set(method, 'forbidden')
      return 'forbidden'
    }
    // Anything else is a normal runtime failure and says nothing about whether
    // the method exists. Notably not cached: a call that timed out once must
    // not disable the feature forever.
    return this.get(method)
  }

  /** A success is proof, and outranks anything previously inferred. */
  learnFromSuccess(method: string): void {
    this.known.set(method, 'available')
  }

  /** For diagnostics and tests. */
  snapshot(): Record<string, Capability> {
    return Object.fromEntries(this.known)
  }
}

/**
 * One line explaining why an affordance is missing.
 *
 * Returned rather than thrown: these appear as inline notes next to a disabled
 * control, and the useful thing to tell a user is which of the two fixes
 * applies — upgrade the gateway, or re-pair the device.
 */
export function explainCapability(capability: Capability, label: string): string | null {
  switch (capability) {
    case 'unsupported':
      return `This gateway does not support ${label}.`
    case 'forbidden':
      return `This device was not granted the scope needed for ${label}. Re-pair to request it.`
    default:
      return null
  }
}
