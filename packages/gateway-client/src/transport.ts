/**
 * The minimum WebSocket surface this client needs.
 *
 * Declared structurally and injected rather than imported, because the three
 * runtimes that matter all provide a `WebSocket` and none of them provide the
 * *same* one: Node has a global since 22 (and `ws` before that), browsers have
 * theirs, and Hermes has React Native's. Importing any concrete implementation
 * would pin the package to one runtime and defeat the point of sharing it.
 *
 * Only the four events and two methods used here are declared. A wider
 * interface would be harder to fake in tests without buying anything.
 */

export interface GatewaySocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly bufferedAmount?: number
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event?: unknown) => void) | null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null
}

/** Opens a socket to `url`. The client never constructs one itself. */
export type SocketFactory = (url: string) => GatewaySocket

/**
 * Resolve a socket factory from whatever global the host runtime provides.
 *
 * Throws rather than returning a stub: a client that silently fails to connect
 * is far harder to diagnose than one that refuses to start.
 */
export function defaultSocketFactory(): SocketFactory {
  const ctor = (globalThis as { WebSocket?: new (url: string) => GatewaySocket }).WebSocket
  if (!ctor) {
    throw new Error(
      'no global WebSocket found — pass an explicit socketFactory (Node <22 needs the `ws` package)',
    )
  }
  return (url: string) => new ctor(url)
}

/**
 * Reconnect backoff: exponential with full jitter, capped.
 *
 * Jitter is not decoration. Every client of a gateway that restarts reconnects
 * at once, and a deterministic backoff makes them retry in lockstep — which is
 * exactly the pattern the auth rate limiter (10 attempts / 60s, then a 5-minute
 * lockout) punishes. `random` is injectable so tests stay deterministic.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 1_000
  const max = opts.maxMs ?? 30_000
  const random = opts.random ?? Math.random
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt))
  return Math.round(random() * ceiling)
}
