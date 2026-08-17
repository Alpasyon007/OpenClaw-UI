/**
 * The shape {@link CapabilityCache} needs from a rejected request.
 *
 * Declared structurally rather than importing `GatewayRequestError` because
 * that class lives in `@openclaw/gateway-client`, which depends on this package
 * — importing it back would close a cycle. Structural typing is enough: the
 * classifier reads two fields.
 */
export interface GatewayRequestErrorLike {
  code?: string
  message?: string
  details?: Record<string, unknown>
  retryable?: boolean
}
