import { describe, it, expect, vi } from 'vitest'
import { buildDeviceAuthPayloadV3, COMPANION_SCOPES, M } from '@openclaw/protocol'
import { GatewayClient, GatewayConnectError, GatewayRequestError } from './client'
import { createFakeGateway, type FakeGatewayOptions } from './fake-gateway'
import { deviceIdentityFromPrivateKey, verifyDeviceSignature } from './device-identity'
import { backoffDelayMs } from './transport'

const identity = deviceIdentityFromPrivateKey(new Uint8Array(32).fill(3))

function makeClient(gatewayOpts: FakeGatewayOptions = {}, clientOverrides = {}) {
  const gateway = createFakeGateway(gatewayOpts)
  const client = new GatewayClient({
    url: 'wss://gateway.test',
    identity,
    auth: { token: 'device-token' },
    scopes: COMPANION_SCOPES,
    client: {
      id: 'openclaw-android',
      version: '0.1.0',
      platform: 'android',
      mode: 'ui',
      deviceFamily: 'Pixel',
    },
    socketFactory: () => gateway.socket,
    handshakeTimeoutMs: 200,
    requestTimeoutMs: 200,
    ...clientOverrides,
  })
  return { gateway, client }
}

describe('handshake', () => {
  it('waits for the challenge before sending connect', async () => {
    const { gateway, client } = makeClient()
    // Nothing may be written until the server speaks. Signing a self-invented
    // nonce yields DEVICE_AUTH_NONCE_MISMATCH, which reads as a credential
    // problem rather than a sequencing one.
    expect(gateway.sent).toHaveLength(0)

    const hello = await client.connect()
    expect(hello.protocol).toBe(4)
    expect(gateway.connectFrame()?.method).toBe('connect')
    client.close()
  })

  it('signs the nonce the server issued', async () => {
    const { gateway, client } = makeClient({ nonce: 'server-issued-nonce' })
    await client.connect()

    const params = gateway.connectFrame()?.params as Record<string, unknown>
    const device = params.device as Record<string, unknown>
    expect(device.nonce).toBe('server-issued-nonce')

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'openclaw-android',
      clientMode: 'ui',
      role: 'operator',
      scopes: params.scopes as string[],
      signedAtMs: device.signedAt as number,
      token: 'device-token',
      nonce: 'server-issued-nonce',
      platform: 'android',
      deviceFamily: 'Pixel',
    })
    expect(verifyDeviceSignature(device.publicKey as string, payload, device.signature as string)).toBe(
      true,
    )
    client.close()
  })

  it('sends the same scopes array it signed', async () => {
    // The gateway joins the received array without sorting. If these ever
    // diverge the signature silently fails and every scope is dropped.
    const { gateway, client } = makeClient()
    await client.connect()
    const params = gateway.connectFrame()?.params as Record<string, unknown>
    expect(params.scopes).toEqual([...COMPANION_SCOPES])
    client.close()
  })

  it('declares protocol 4 in both bounds', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    const params = gateway.connectFrame()?.params as Record<string, unknown>
    expect(params.minProtocol).toBe(4)
    expect(params.maxProtocol).toBe(4)
    client.close()
  })

  it('adopts the granted scopes rather than the requested ones', async () => {
    const { client } = makeClient({ grantScopes: ['operator.read'] })
    await client.connect()
    // Asking for three and being granted one is the normal outcome of a pairing
    // that was approved at a narrower scope.
    expect(client.getGrantedScopes()).toEqual(['operator.read'])
    client.close()
  })

  it('warns when zero scopes are granted', async () => {
    // The signature failing does not fail the handshake — it grants nothing.
    // Without a warning here the first failing call looks like an authz bug.
    const onLog = vi.fn()
    const { client } = makeClient({ grantScopes: [] }, { onLog })
    await client.connect()
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('zero scopes'))
    client.close()
  })

  it('adopts the server tick interval', async () => {
    const { client } = makeClient({ tickIntervalMs: 5_000 })
    const hello = await client.connect()
    expect(hello.policy?.tickIntervalMs).toBe(5_000)
    client.close()
  })

  it('classifies a pairing-required rejection as retryable', async () => {
    const { client } = makeClient({
      rejectConnect: {
        code: 'NOT_PAIRED',
        message: 'device pairing required',
        details: { code: 'PAIRING_REQUIRED', reason: 'not-paired' },
        retryable: true,
      },
    })

    // Captured once: a second connect() would find the challenge already spent
    // and time out instead, which would assert nothing about classification.
    const error = await client.connect().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GatewayConnectError)
    expect(error).toMatchObject({ rejection: { kind: 'pairing-required', reason: 'not-paired' } })
  })

  it('classifies the startup-sidecars race as retryable', async () => {
    const { client } = makeClient({
      rejectConnect: {
        code: 'UNAVAILABLE',
        message: 'starting',
        details: { reason: 'startup-sidecars' },
        retryable: true,
      },
    })
    await expect(client.connect()).rejects.toMatchObject({ rejection: { kind: 'unavailable' } })
  })

  it('times out when no challenge ever arrives', async () => {
    const { client } = makeClient({ withholdChallenge: true })
    await expect(client.connect()).rejects.toThrow(/timed out/)
  })

  it('refuses a second concurrent connect', async () => {
    const { client } = makeClient()
    const first = client.connect()
    await expect(client.connect()).rejects.toThrow(/already connected/)
    await first
    client.close()
  })
})

describe('requests', () => {
  it('round-trips a request and response', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const promise = client.request(M.SESSIONS_LIST, { limit: 10 })
    gateway.respond(M.SESSIONS_LIST, { sessions: [{ key: 'agent:main:main' }] })
    await expect(promise).resolves.toEqual({ sessions: [{ key: 'agent:main:main' }] })
    client.close()
  })

  it('correlates concurrent requests by id', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const a = client.request(M.SESSIONS_LIST)
    const b = client.request(M.MODELS_LIST)
    // Answered out of order on purpose — correlation must be by id, not arrival.
    gateway.respond(M.MODELS_LIST, { models: ['m'] })
    gateway.respond(M.SESSIONS_LIST, { sessions: [] })

    await expect(a).resolves.toEqual({ sessions: [] })
    await expect(b).resolves.toEqual({ models: ['m'] })
    client.close()
  })

  it('rejects with the gateway error code', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const promise = client.request(M.CHAT_HISTORY, { sessionKey: 'k', offset: 0 })
    gateway.respondError(M.CHAT_HISTORY, { code: 'INVALID_REQUEST', message: 'no such session' })

    await expect(promise).rejects.toBeInstanceOf(GatewayRequestError)
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    client.close()
  })

  it('pre-checks scopes and names the missing one', async () => {
    // The gateway's own answer is a bare "missing scope", which gives a user
    // nothing to act on. Naming the scope is the whole point of the pre-check.
    const { client } = makeClient({ grantScopes: ['operator.read'] })
    await client.connect()

    await expect(client.request(M.CHAT_SEND, {})).rejects.toThrow(/operator\.write/)
    client.close()
  })

  it('allows a read when only write was granted', async () => {
    // operator.write satisfies operator.read; a naive includes() would refuse.
    const { gateway, client } = makeClient({ grantScopes: ['operator.write'] })
    await client.connect()
    const promise = client.request(M.SESSIONS_LIST)
    gateway.respond(M.SESSIONS_LIST, { sessions: [] })
    await expect(promise).resolves.toBeDefined()
    client.close()
  })

  it('allows everything when admin was granted', async () => {
    const { gateway, client } = makeClient({ grantScopes: ['operator.admin'] })
    await client.connect()
    const promise = client.request(M.EXEC_APPROVAL_RESOLVE, { id: 'a', decision: 'deny' })
    gateway.respond(M.EXEC_APPROVAL_RESOLVE, { ok: true })
    await expect(promise).resolves.toBeDefined()
    client.close()
  })

  it('times out a request that is never answered', async () => {
    const { client } = makeClient()
    await client.connect()
    await expect(client.request(M.SESSIONS_LIST)).rejects.toThrow(/timed out/)
    client.close()
  })

  it('settles on the interim ack by default', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    const promise = client.request(M.SESSIONS_LIST)
    gateway.respond(M.SESSIONS_LIST, { status: 'accepted' })
    await expect(promise).resolves.toEqual({ status: 'accepted' })
    client.close()
  })

  it('waits past the interim ack for the final response when expectFinal is set', async () => {
    // Some methods answer twice on the same id: an immediate {status:"accepted"}
    // and then the real result. Settling on the first drops the answer and — as
    // the correlation entry is already gone — the second arrives as an unknown
    // id and is silently discarded.
    const { gateway, client } = makeClient()
    await client.connect()

    const accepted = vi.fn()
    const promise = client.request(M.CHAT_SEND, {}, { expectFinal: true, onAccepted: accepted })

    gateway.respond(M.CHAT_SEND, { status: 'accepted', runId: 'run-1' })
    expect(accepted).toHaveBeenCalledWith({ status: 'accepted', runId: 'run-1' })

    gateway.respond(M.CHAT_SEND, { status: 'ok', runId: 'run-1', result: 'done' })
    await expect(promise).resolves.toMatchObject({ status: 'ok', result: 'done' })
    client.close()
  })

  it('still times out when an accepted run never finishes', async () => {
    // Holding the correlation open must not mean holding it open forever.
    const { gateway, client } = makeClient()
    await client.connect()
    const promise = client.request(M.CHAT_SEND, {}, { expectFinal: true })
    gateway.respond(M.CHAT_SEND, { status: 'accepted' })
    await expect(promise).rejects.toThrow(/timed out/)
    client.close()
  })

  it('settles immediately on a non-accepted response even with expectFinal', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    const promise = client.request(M.CHAT_SEND, {}, { expectFinal: true })
    gateway.respond(M.CHAT_SEND, { status: 'ok', runId: 'r' })
    await expect(promise).resolves.toMatchObject({ status: 'ok' })
    client.close()
  })

  it('fails fast when a two-phase call is rejected outright', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    const promise = client.request(M.CHAT_SEND, {}, { expectFinal: true })
    gateway.respondError(M.CHAT_SEND, { code: 'INVALID_REQUEST', message: 'bad session' })
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    client.close()
  })

  it('survives a throwing onAccepted handler', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    const promise = client.request(M.CHAT_SEND, {}, {
      expectFinal: true,
      onAccepted: () => {
        throw new Error('handler blew up')
      },
    })
    gateway.respond(M.CHAT_SEND, { status: 'accepted' })
    gateway.respond(M.CHAT_SEND, { status: 'ok' })
    await expect(promise).resolves.toMatchObject({ status: 'ok' })
    client.close()
  })

  it('refuses to send before the handshake completes', async () => {
    const { client } = makeClient()
    await expect(client.request(M.SESSIONS_LIST)).rejects.toThrow(/not ready/)
  })

  it('fails every pending request when the socket closes', async () => {
    // A promise that never settles is worse than one that rejects: the UI keeps
    // a spinner forever with nothing to retry against.
    const { gateway, client } = makeClient()
    await client.connect()

    const promise = client.request(M.SESSIONS_LIST)
    gateway.close(1006)
    await expect(promise).rejects.toThrow(/closed/)
  })
})

describe('events', () => {
  it('delivers a subscribed event', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const seen: unknown[] = []
    client.on('chat', (payload) => seen.push(payload))
    gateway.emit('chat', { state: 'delta', runId: 'r', sessionKey: 'k', deltaText: 'hi' })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ deltaText: 'hi' })
    client.close()
  })

  it('supports multiple handlers and unsubscribe', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const a = vi.fn()
    const b = vi.fn()
    const offA = client.on('chat', a)
    client.on('chat', b)

    gateway.emit('chat', { x: 1 })
    offA()
    gateway.emit('chat', { x: 2 })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    client.close()
  })

  it('isolates a throwing handler from the others', async () => {
    // One bad subscriber must not stop the rest or take down the socket.
    const { gateway, client } = makeClient()
    await client.connect()

    const good = vi.fn()
    client.on('chat', () => {
      throw new Error('subscriber blew up')
    })
    client.on('chat', good)

    expect(() => gateway.emit('chat', {})).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('lets a handler unsubscribe itself mid-dispatch', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const calls: string[] = []
    const off = client.on('chat', () => {
      calls.push('self')
      off()
    })
    client.on('chat', () => calls.push('other'))

    gateway.emit('chat', {})
    expect(calls).toEqual(['self', 'other'])
    gateway.emit('chat', {})
    expect(calls).toEqual(['self', 'other', 'other'])
    client.close()
  })

  it('survives an unreadable frame without dropping the connection', async () => {
    const { gateway, client } = makeClient()
    await client.connect()

    const seen = vi.fn()
    client.on('chat', seen)

    gateway.raw('this is not json')
    gateway.raw('{"type":"banana"}')
    gateway.emit('chat', { ok: true })

    expect(seen).toHaveBeenCalledTimes(1)
    expect(client.getState()).toBe('ready')
    client.close()
  })

  it('ignores an event with no subscribers', async () => {
    const { gateway, client } = makeClient()
    await client.connect()
    expect(() => gateway.emit('some.unwatched.event', {})).not.toThrow()
    client.close()
  })
})

describe('backoffDelayMs', () => {
  it('grows exponentially and caps', () => {
    const random = () => 1
    expect(backoffDelayMs(0, { random })).toBe(1_000)
    expect(backoffDelayMs(1, { random })).toBe(2_000)
    expect(backoffDelayMs(2, { random })).toBe(4_000)
    expect(backoffDelayMs(20, { random })).toBe(30_000)
  })

  it('applies full jitter', () => {
    // Without jitter every client of a restarted gateway retries in lockstep,
    // which is precisely the pattern the auth rate limiter punishes.
    expect(backoffDelayMs(3, { random: () => 0 })).toBe(0)
    expect(backoffDelayMs(3, { random: () => 0.5 })).toBe(4_000)
  })

  it('never returns a negative delay', () => {
    expect(backoffDelayMs(-5, { random: () => 1 })).toBe(1_000)
  })
})
