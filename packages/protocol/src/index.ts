/**
 * `@openclaw/protocol` — wire types and runtime schemas for the OpenClaw
 * gateway WebSocket protocol.
 *
 * Deliberately dependency-free apart from zod, and free of any Node or DOM API,
 * so the same module compiles for the sidecar (Node), the renderer (browser) and
 * the phone app (Hermes). Anything that needs a socket, a filesystem or a
 * keystore belongs in `@openclaw/gateway-client`, not here.
 */
export * from './frames'
export * from './connect'
export * from './device-auth'
export * from './events'
export * from './methods'
export * from './session-keys'
