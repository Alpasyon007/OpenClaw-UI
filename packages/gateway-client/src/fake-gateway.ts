/**
 * An in-memory gateway, for tests.
 *
 * Speaks the real frame protocol — challenge first, then `connect`, then
 * responses and events — without a socket, a port or a timer. That matters
 * because the behaviours worth testing here are sequencing ones (challenge
 * before connect, scopes granted after hello, pending requests failing on
 * close), and those are the exact behaviours a mock built on `vi.fn()` would
 * paper over.
 *
 * Exported from the package rather than hidden in a test folder so the mobile
 * app and the sidecar can reuse it for their own tests.
 */
import type { GatewaySocket } from './transport'

export interface FakeGatewayOptions {
  nonce?: string
  /** Scopes to grant. Defaults to whatever the client requested. */
  grantScopes?: string[]
  /** Reject `connect` with this error instead of accepting it. */
  rejectConnect?: { code: string; message: string; details?: Record<string, unknown>; retryable?: boolean }
  tickIntervalMs?: number
  /** Suppress the opening challenge, to test the handshake timeout. */
  withholdChallenge?: boolean
}

export interface FakeGateway {
  socket: GatewaySocket
  /** Every frame the client sent, parsed. */
  readonly sent: Array<Record<string, unknown>>
  /** The `connect` frame, once it arrives. */
  connectFrame(): Record<string, unknown> | undefined
  /** Answer a pending request by method name. */
  respond(method: string, payload: unknown): void
  /** Fail a pending request by method name. */
  respondError(method: string, error: { code: string; message: string; details?: Record<string, unknown> }): void
  /** Push a server event. */
  emit(event: string, payload?: unknown, seq?: number): void
  /** Send a raw string, to test malformed input. */
  raw(text: string): void
  close(code?: number, reason?: string): void
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const sent: Array<Record<string, unknown>> = []
  const nonce = options.nonce ?? 'fake-nonce-0000'

  const socket: GatewaySocket = {
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: string) {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(data) as Record<string, unknown>
      } catch {
        throw new Error('client sent a non-JSON frame')
      }
      sent.push(frame)

      if (frame.method === 'connect') {
        queueMicrotask(() => {
          if (options.rejectConnect) {
            deliver({ type: 'res', id: frame.id, ok: false, error: options.rejectConnect })
            return
          }
          const requested = Array.isArray(frame.params && (frame.params as Record<string, unknown>).scopes)
            ? ((frame.params as Record<string, unknown>).scopes as string[])
            : []
          deliver({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {
              type: 'hello-ok',
              protocol: 4,
              server: { version: 'fake', connId: 'conn-1' },
              features: { methods: [], events: [] },
              auth: {
                role: (frame.params as Record<string, unknown>)?.role ?? 'operator',
                scopes: options.grantScopes ?? requested,
              },
              policy: { tickIntervalMs: options.tickIntervalMs ?? 15_000 },
            },
          })
        })
      }
    },
    close() {
      queueMicrotask(() => socket.onclose?.({ code: 1000 }))
    },
  }

  function deliver(frame: unknown): void {
    socket.onmessage?.({ data: JSON.stringify(frame) })
  }

  // The server speaks first. Deferred by a microtask so the caller can attach
  // handlers, exactly as a real socket's open/message ordering allows.
  if (!options.withholdChallenge) {
    queueMicrotask(() => deliver({ type: 'event', event: 'connect.challenge', payload: { nonce, ts: 1 } }))
  }

  const findPending = (method: string): Record<string, unknown> | undefined =>
    [...sent].reverse().find((f) => f.method === method)

  return {
    socket,
    sent,
    connectFrame: () => sent.find((f) => f.method === 'connect'),
    respond(method, payload) {
      const frame = findPending(method)
      if (!frame) throw new Error(`no pending request for ${method}`)
      deliver({ type: 'res', id: frame.id, ok: true, payload })
    },
    respondError(method, error) {
      const frame = findPending(method)
      if (!frame) throw new Error(`no pending request for ${method}`)
      deliver({ type: 'res', id: frame.id, ok: false, error })
    },
    emit(event, payload, seq) {
      // `stateVersion` is included, and is an OBJECT, because the real gateway
      // sends one on broadcast events. A fake that omits it — or models it as a
      // number, as an earlier revision did — lets a schema bug pass every test
      // and then drop real events on the wire.
      deliver({
        type: 'event',
        event,
        payload,
        seq,
        stateVersion: { presence: 1091, health: 37631 },
      })
    },
    raw(text) {
      socket.onmessage?.({ data: text })
    },
    close(code, reason) {
      socket.onclose?.({ code: code ?? 1000, reason })
    },
  }
}
