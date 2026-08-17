/**
 * `@openclaw/gateway-client` — a typed client for the OpenClaw gateway.
 *
 * Runs unchanged in Node and under Hermes: no `Buffer`, no `node:crypto`, no
 * `ws`. The WebSocket itself is injected rather than imported, because the
 * global `WebSocket` in Hermes and the one in Node are different objects with
 * the same shape, and importing either would pin the package to one runtime.
 */
export * from './base64url'
export * from './device-identity'
export * from './transport'
export * from './client'
