/**
 * The gateway client: one socket, one handshake, request/response correlation
 * and a scope-filtered event stream.
 *
 * Deliberately *not* auto-reconnecting internally. Reconnect policy needs to
 * know things this layer does not — whether the app is foregrounded, whether a
 * pairing approval is pending, whether the user has since revoked the device —
 * and a client that reconnects on its own fights whatever owns that policy.
 * {@link GatewayClient} reports what happened and lets the caller decide;
 * `backoffDelayMs` is exported for callers that want the standard schedule.
 */
import {
  CONNECT_CHALLENGE_EVENT,
  ConnectChallengePayloadSchema,
  HelloOkSchema,
  PROTOCOL_VERSION,
  classifyConnectError,
  parseServerFrame,
  resolveSignatureToken,
  satisfiesScope,
  METHOD_SCOPES,
  type ConnectAuth,
  type ConnectRejection,
  type EventFrame,
  type HelloOk,
  type MethodName,
  type Role,
  type Scope,
  type ServerFrame,
} from '@openclaw/protocol'
import { signConnectChallenge, type DeviceIdentity } from './device-identity'
import { defaultSocketFactory, type GatewaySocket, type SocketFactory } from './transport'

export type ClientState = 'idle' | 'connecting' | 'ready' | 'closed'

/**
 * A known method name, or any other string.
 *
 * The intersection with `Record<never, never>` is load-bearing: a plain
 * `MethodName | string` collapses to `string` and loses autocomplete over the
 * known set. Plugins register methods at runtime that this package cannot
 * enumerate, so the type has to stay open — it just should not be *only* open.
 */
export type AnyMethod = MethodName | (string & Record<never, never>)

export interface GatewayClientOptions {
  url: string
  identity: DeviceIdentity
  auth: ConnectAuth
  role?: Role
  scopes?: readonly Scope[] | readonly string[]
  client: {
    id: string
    version: string
    platform: string
    mode: string
    deviceFamily?: string
    displayName?: string
    instanceId?: string
  }
  socketFactory?: SocketFactory
  /** Per-request timeout. The reference client uses 30s. */
  requestTimeoutMs?: number
  /** Budget for challenge + connect. The reference client uses 15s. */
  handshakeTimeoutMs?: number
  /** Injectable for tests. */
  now?: () => number
  /** Diagnostics. Must never receive credential material. */
  onLog?: (message: string) => void
}

export type GatewayEventHandler = (payload: unknown, frame: EventFrame) => void

export class GatewayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryable?: boolean,
  ) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}

export class GatewayConnectError extends Error {
  constructor(
    readonly rejection: ConnectRejection,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayConnectError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Keep the correlation open past an interim `accepted` ack. */
  expectFinal: boolean
  onAccepted?: (payload: unknown) => void
}

export interface RequestOptions {
  /**
   * Wait for the *final* response rather than settling on the interim ack.
   *
   * Some methods answer twice on the same request id: an immediate
   * `{status:"accepted"}` and then, when the work finishes, a second response
   * reusing that id. Without this the request resolves with the ack — which has
   * no result in it — and the real answer is dropped as an unknown correlation.
   */
  expectFinal?: boolean
  /** Fired on the interim ack when `expectFinal` is set. */
  onAccepted?: (payload: unknown) => void
  /** Overrides the client-wide default. */
  timeoutMs?: number
}

/** Interim-ack marker. The second response reuses the same request id. */
function isAcceptedAck(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { status?: unknown }).status === 'accepted'
  )
}

export class GatewayClient {
  private socket: GatewaySocket | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Map<string, Set<GatewayEventHandler>>()
  private nextId = 1
  private helloOk: HelloOk | null = null
  private grantedScopes: string[] = []
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private tickIntervalMs: number
  private state: ClientState = 'idle'

  constructor(private readonly opts: GatewayClientOptions) {
    this.tickIntervalMs = 30_000
  }

  getState(): ClientState {
    return this.state
  }

  /** Scopes the gateway actually granted — not the ones we asked for. */
  getGrantedScopes(): readonly string[] {
    return this.grantedScopes
  }

  getHello(): HelloOk | null {
    return this.helloOk
  }

  private log(message: string): void {
    this.opts.onLog?.(message)
  }

  // ─── Connection ───

  /**
   * Open a socket and complete the handshake.
   *
   * Resolves with `hello-ok` once the gateway has accepted the device. Rejects
   * with {@link GatewayConnectError} carrying a classified rejection, so a
   * caller can distinguish "wait and retry" (pairing pending, sidecars booting)
   * from "stop and tell the user" (bad credential, protocol too old).
   */
  async connect(): Promise<HelloOk> {
    if (this.state === 'connecting' || this.state === 'ready') {
      throw new Error('connect() called while already connected')
    }
    this.state = 'connecting'

    const factory = this.opts.socketFactory ?? defaultSocketFactory()
    const socket = factory(this.opts.url)
    this.socket = socket

    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false
      const timeoutMs = this.opts.handshakeTimeoutMs ?? 15_000

      const finish = (error: Error | null, hello?: HelloOk) => {
        if (settled) return
        settled = true
        clearTimeout(handshakeTimer)
        if (error) {
          this.teardown()
          reject(error)
        } else {
          resolve(hello as HelloOk)
        }
      }

      const handshakeTimer = setTimeout(() => {
        finish(new Error(`gateway handshake timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      socket.onerror = () => finish(new Error('gateway socket error before handshake completed'))

      socket.onclose = (event) => {
        const code = event?.code
        // 1008 is the gateway telling us we stopped draining the socket. It is
        // worth naming: the generic "closed" message sends people looking at
        // credentials when the real cause is a blocked event loop.
        const detail = code === 1008 ? ' (slow consumer — the client fell behind)' : ''
        finish(new Error(`gateway socket closed${code ? ` with code ${code}` : ''}${detail}`))
        this.failAllPending(new Error('gateway connection closed'))
        this.state = 'closed'
      }

      socket.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        const parsed = parseServerFrame(raw)
        if (!parsed.ok) {
          // A frame we cannot read is a diagnostic, never fatal: the socket
          // carries broadcast traffic for capabilities this client never uses.
          this.log(`dropped an unreadable frame: ${parsed.error}`)
          return
        }

        const frame = parsed.frame

        if (frame.type === 'event' && frame.event === CONNECT_CHALLENGE_EVENT && !settled) {
          const challenge = ConnectChallengePayloadSchema.safeParse(frame.payload)
          if (!challenge.success) {
            finish(new Error('gateway sent a connect challenge with no usable nonce'))
            return
          }
          this.sendConnect(challenge.data.nonce).catch((err: unknown) =>
            finish(err instanceof Error ? err : new Error(String(err))),
          )
          return
        }

        if (frame.type === 'res' && !settled) {
          if (!frame.ok) {
            const rejection = classifyConnectError(frame.error)
            finish(
              new GatewayConnectError(
                rejection,
                frame.error?.message ?? 'the gateway refused the connection',
              ),
            )
            return
          }
          const hello = HelloOkSchema.safeParse(frame.payload)
          if (!hello.success) {
            finish(new Error('gateway accepted the connection but sent an unreadable hello-ok'))
            return
          }
          this.adoptHello(hello.data)
          this.state = 'ready'
          // Swap in the steady-state handlers now the handshake is done.
          this.installRuntimeHandlers(socket)
          finish(null, hello.data)
          return
        }

        this.dispatch(frame)
      }
    })
  }

  private async sendConnect(rawNonce: string): Promise<void> {
    const nonce = rawNonce.trim()
    const role: Role = this.opts.role ?? 'operator'
    // Signed and sent must be the same array: the gateway joins what it
    // receives without sorting, so a reordered copy cannot verify.
    const scopes = [...(this.opts.scopes ?? [])]

    const device = signConnectChallenge({
      identity: this.opts.identity,
      nonce,
      clientId: this.opts.client.id,
      clientMode: this.opts.client.mode,
      role,
      scopes,
      token: resolveSignatureToken(this.opts.auth),
      platform: this.opts.client.platform,
      deviceFamily: this.opts.client.deviceFamily,
      signedAtMs: this.opts.now?.(),
    })

    this.writeFrame({
      type: 'req',
      id: this.mintId(),
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: this.opts.client,
        role,
        scopes,
        device,
        auth: this.opts.auth,
      },
    })
  }

  private adoptHello(hello: HelloOk): void {
    this.helloOk = hello
    this.grantedScopes = hello.auth?.scopes ?? []
    // Prefer the server's live policy over our compiled-in defaults.
    const interval = hello.policy?.tickIntervalMs
    if (typeof interval === 'number' && interval > 0) this.tickIntervalMs = interval

    if (this.grantedScopes.length === 0) {
      // Almost always a signature that did not verify. The gateway does not
      // reject the handshake for it — it grants nothing — so without this the
      // first failing call looks like an authorization bug.
      this.log(
        'gateway granted zero scopes — the device signature probably did not verify; ' +
          'check that the signed scopes array, platform and deviceFamily match what was sent',
      )
    }

    this.armTickTimer()
  }

  private installRuntimeHandlers(socket: GatewaySocket): void {
    socket.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      const parsed = parseServerFrame(raw)
      if (!parsed.ok) {
        this.log(`dropped an unreadable frame: ${parsed.error}`)
        return
      }
      this.dispatch(parsed.frame)
    }

    socket.onclose = (event) => {
      this.state = 'closed'
      this.clearTickTimer()
      this.failAllPending(
        new Error(`gateway connection closed${event?.code ? ` (code ${event.code})` : ''}`),
      )
    }

    socket.onerror = () => this.log('gateway socket reported an error')
  }

  // ─── Frames ───

  private mintId(): string {
    return String(this.nextId++)
  }

  private writeFrame(frame: unknown): void {
    const socket = this.socket
    if (!socket) throw new Error('gateway socket is not open')
    socket.send(JSON.stringify(frame))
  }

  private dispatch(frame: ServerFrame): void {
    const f = frame as {
      type: string
      id?: string
      ok?: boolean
      payload?: unknown
      error?: unknown
      event?: string
    }

    if (f.type === 'res' && typeof f.id === 'string') {
      const pending = this.pending.get(f.id)
      if (!pending) return

      // Two-phase: hold the correlation open for the real answer. The timeout
      // is deliberately left running — an accepted run that never completes
      // must still fail rather than hang forever.
      if (f.ok && pending.expectFinal && isAcceptedAck(f.payload)) {
        try {
          pending.onAccepted?.(f.payload)
        } catch (err) {
          this.log(`onAccepted handler threw: ${String(err)}`)
        }
        return
      }

      this.pending.delete(f.id)
      clearTimeout(pending.timer)

      if (f.ok) {
        pending.resolve(f.payload)
      } else {
        const err = f.error as
          | { code?: string; message?: string; details?: Record<string, unknown>; retryable?: boolean }
          | undefined
        pending.reject(
          new GatewayRequestError(
            err?.code ?? 'UNKNOWN',
            err?.message ?? 'the gateway rejected the request',
            err?.details,
            err?.retryable,
          ),
        )
      }
      return
    }

    if (f.type === 'event' && typeof f.event === 'string') {
      // Any inbound frame proves the server is alive, so the silence timer
      // resets on all of them. `tick` matters only because it is the one frame
      // guaranteed to keep arriving on a connection that is otherwise idle.
      this.armTickTimer()
      this.emit(f.event, f.payload, frame as EventFrame)
    }
  }

  private emit(event: string, payload: unknown, frame: EventFrame): void {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    // Snapshot: a handler that unsubscribes itself must not perturb this pass.
    for (const handler of [...handlers]) {
      try {
        handler(payload, frame)
      } catch (err) {
        // One bad subscriber must not stop the others or kill the socket.
        this.log(`event handler for "${event}" threw: ${String(err)}`)
      }
    }
  }

  // ─── Liveness ───

  private armTickTimer(): void {
    this.clearTickTimer()
    // Reference clients close after twice the advertised interval of silence.
    this.tickTimer = setTimeout(() => {
      this.log('gateway went silent past twice the tick interval — closing')
      this.close(4000, 'tick timeout')
    }, this.tickIntervalMs * 2)
    // Never let liveness hold a Node process open.
    ;(this.tickTimer as unknown as { unref?: () => void }).unref?.()
  }

  private clearTickTimer(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickTimer = null
  }

  // ─── Requests ───

  /**
   * Issue an RPC.
   *
   * Pre-checks the granted scopes when the method is one we know, so the error
   * names the missing scope instead of surfacing the gateway's bare
   * `missing scope`, which gives a user nothing to act on.
   */
  async request<T = unknown>(
    method: AnyMethod,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    if (this.state !== 'ready') {
      throw new Error(`cannot call ${method}: client is ${this.state}, not ready`)
    }

    const required = METHOD_SCOPES[method as MethodName]
    if (required && !satisfiesScope(this.grantedScopes, required)) {
      throw new GatewayRequestError(
        'MISSING_SCOPE',
        `${method} needs the ${required} scope, which this device was not granted`,
      )
    }

    const id = this.mintId()
    const timeoutMs = options.timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        expectFinal: options.expectFinal ?? false,
        onAccepted: options.onAccepted,
      })

      try {
        this.writeFrame({ type: 'req', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Subscribe to a server event. Returns an unsubscribe function. */
  on(event: string, handler: GatewayEventHandler): () => void {
    let handlers = this.listeners.get(event)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.listeners.delete(event)
    }
  }

  // ─── Teardown ───

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private teardown(): void {
    this.clearTickTimer()
    const socket = this.socket
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        // Closing an already-dead socket is not an error worth surfacing.
      }
    }
    this.socket = null
    this.state = 'closed'
  }

  close(code?: number, reason?: string): void {
    this.clearTickTimer()
    this.failAllPending(new Error('gateway client closed'))
    const socket = this.socket
    if (socket) {
      try {
        socket.close(code, reason)
      } catch {
        // As above.
      }
    }
    this.teardown()
  }
}
