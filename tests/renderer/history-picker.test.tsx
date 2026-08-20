import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HistoryPicker } from '../../src/renderer/components/HistoryPicker'
import { PopoverLayerProvider } from '../../src/renderer/components/PopoverLayer'
import { cluiStub } from '../helpers/clui-stub'
import type { GatewaySessionListResult, SessionMeta } from '../../src/shared/types'

/**
 * The history picker now draws two lists from two very different places: a
 * filesystem read that returns in milliseconds, and a gateway round trip that
 * takes seconds and can fail in four distinct ways.
 *
 * The property that matters is isolation. Commit a8ba2c8 restored this picker
 * after an id-less row was dereferenced during render and unmounted the entire
 * React root — the launcher went blank and stayed blank. So the gateway list
 * must never be able to empty, delay, or throw into the local list, no matter
 * what comes back over the bridge.
 */

const LOCAL: SessionMeta[] = [
  {
    sessionId: '30088f4f-6234-4463-975b-b2253bf06736',
    slug: 'local-slug',
    firstMessage: 'a local conversation',
    lastTimestamp: new Date().toISOString(),
    size: 2048,
  },
]

const GATEWAY_OK: GatewaySessionListResult = {
  ok: true,
  available: true,
  reason: null,
  error: null,
  fetchedAt: Date.now(),
  sessions: [
    {
      sessionKey: 'agent:main:dashboard:9ce7466d',
      sessionId: 'e3677627',
      displayName: 'Nova Node Permissions Issue',
      kind: 'direct',
      lastTimestamp: new Date().toISOString(),
      model: 'deepseek-v4-flash:cloud',
      totalTokens: 70821,
      status: 'done',
      hasActiveRun: false,
      archived: false,
      pinned: false,
      unread: false,
    },
    {
      sessionKey: 'agent:main:clui-a7105ce4-7dda-4e8b-adf9-9940e775fa40',
      sessionId: 'fe7e4647',
      displayName: null,
      kind: 'direct',
      lastTimestamp: new Date().toISOString(),
      model: null,
      totalTokens: null,
      status: 'done',
      hasActiveRun: false,
      archived: false,
      pinned: false,
      unread: false,
    },
  ],
}

async function openPicker() {
  render(
    <PopoverLayerProvider>
      <HistoryPicker />
    </PopoverLayerProvider>,
  )
  await userEvent.click(screen.getByTitle('Resume a previous session'))
}

describe('HistoryPicker', () => {
  it('lists gateway sessions beside local ones, attributing both', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', LOCAL)
    stub.resolve('listGatewaySessions', GATEWAY_OK)

    await openPicker()

    await waitFor(() => expect(screen.getByText('a local conversation')).toBeInTheDocument())
    expect(screen.getByText('This machine')).toBeInTheDocument()
    expect(screen.getByText('On the gateway')).toBeInTheDocument()
    // The gateway's own title wins where it has one.
    expect(screen.getByText('Nova Node Permissions Issue')).toBeInTheDocument()
    // This app's own keys have none, so they are labelled from the key.
    expect(screen.getByText('Tab a7105ce4')).toBeInTheDocument()
  })

  it('hides the gateway group entirely when there is no gateway to ask', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', LOCAL)
    // 'unsupported' is the stub default — no gateway configured is a normal
    // state, not an error worth explaining to the user.
    await openPicker()

    await waitFor(() => expect(screen.getByText('a local conversation')).toBeInTheDocument())
    expect(screen.queryByText('On the gateway')).not.toBeInTheDocument()
  })

  it('explains an unreachable gateway without disturbing the local list', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', LOCAL)
    stub.resolve('listGatewaySessions', {
      ok: false,
      available: false,
      sessions: [],
      reason: 'unreachable',
      error: 'Could not reach the gateway.',
      fetchedAt: Date.now(),
    } satisfies GatewaySessionListResult)

    await openPicker()

    await waitFor(() => expect(screen.getByText('Could not reach the gateway.')).toBeInTheDocument())
    expect(screen.getByText('a local conversation')).toBeInTheDocument()
  })

  it('survives a bridge method that throws, still rendering local sessions', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', LOCAL)
    // What a stale shim looks like: the method is absent and the call throws.
    ;(window as unknown as { clui: Record<string, unknown> }).clui.listGatewaySessions = () => {
      throw new Error('bridge unavailable')
    }

    await openPicker()

    await waitFor(() => expect(screen.getByText('a local conversation')).toBeInTheDocument())
    expect(screen.queryByText('On the gateway')).not.toBeInTheDocument()
  })

  it('drops a gateway row with no key rather than rendering it', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', [])
    stub.resolve('listGatewaySessions', {
      ...GATEWAY_OK,
      sessions: [...GATEWAY_OK.sessions, { sessionKey: '' }, null] as never,
    })

    await openPicker()

    await waitFor(() => expect(screen.getByText('Nova Node Permissions Issue')).toBeInTheDocument())
    // Two valid rows survive; the malformed pair never reaches render.
    expect(screen.getByText('Tab a7105ce4')).toBeInTheDocument()
    expect(screen.getByText('No local sessions found')).toBeInTheDocument()
  })

  it('never draws the gateway header over nothing while refetching', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', LOCAL)

    const UNREACHABLE: GatewaySessionListResult = {
      ok: false,
      available: false,
      sessions: [],
      reason: 'unreachable',
      error: 'Could not reach the gateway.',
      fetchedAt: Date.now(),
    }
    // The second fetch is left pending on purpose. A stub that resolves
    // immediately never lets the in-flight state be observed, and the in-flight
    // state is the whole bug: `gateway` holds the old failure while
    // `gatewayLoading` is true, and the sidecar's 10s failure TTL means this
    // really does block on a fresh spawn rather than answering from cache.
    let call = 0
    ;(window as unknown as { clui: Record<string, unknown> }).clui.listGatewaySessions = () => {
      call++
      return call === 1 ? Promise.resolve(UNREACHABLE) : new Promise(() => {})
    }

    const user = userEvent.setup()
    render(
      <PopoverLayerProvider>
        <HistoryPicker />
      </PopoverLayerProvider>,
    )
    const trigger = screen.getByTitle('Resume a previous session')

    await user.click(trigger)
    await waitFor(() => expect(screen.getByText('Could not reach the gateway.')).toBeInTheDocument())

    // Close, then reopen. The popover is never unmounted, so the stale
    // unavailable result is still in state on the way back in.
    await user.click(trigger)
    await user.click(trigger)

    expect(screen.getByText('On the gateway')).toBeInTheDocument()
    // Every body branch used to be false here, leaving the header over an
    // empty box with no indication anything was happening.
    const explained =
      screen.queryByText('Checking gateway...') ?? screen.queryByText('Could not reach the gateway.')
    expect(explained).not.toBeNull()
  })

  it('reattaches to the gateway session by key, not by transcript id', async () => {
    const stub = cluiStub()
    stub.resolve('listSessions', [])
    stub.resolve('listGatewaySessions', GATEWAY_OK)

    await openPicker()
    await waitFor(() => expect(screen.getByText('Nova Node Permissions Issue')).toBeInTheDocument())
    await userEvent.click(screen.getByText('Nova Node Permissions Issue'))

    // The key is what `--session-key` takes; a transcript UUID would name a
    // different, empty conversation.
    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === 'loadGatewaySession' && c.args[0] === 'agent:main:dashboard:9ce7466d')).toBe(true),
    )
  })
})
