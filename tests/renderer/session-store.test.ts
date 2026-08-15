import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../../src/renderer/stores/sessionStore'
import type { NormalizedEvent } from '../../src/shared/types'

/**
 * The store reduces the CLI's event stream into the transcript. Two properties
 * decide whether the UI is trustworthy:
 *
 *   1. Immutability. Zustand hands the same object graph to React, and
 *      `React.memo` on the message rows compares by reference. A reducer that
 *      mutates a message in place produces a store update React declines to
 *      render — the state is right and the screen is stale.
 *
 *   2. Isolation. Events are tagged with a tab id and arrive asynchronously,
 *      including after that tab is gone. A reducer that does not check
 *      ownership writes one conversation's output into another's transcript.
 */

const TAB = 'tab-under-test'

function seedTab() {
  useSessionStore.setState({
    tabs: [
      {
        id: TAB,
        title: 'Test',
        status: 'idle',
        messages: [],
        queuedPrompts: [],
        attachments: [],
        claudeSessionId: null,
        sessionModel: null,
        sessionTools: [],
        sessionMcpServers: [],
        sessionSkills: [],
        sessionVersion: null,
        workingDirectory: '~',
        hasChosenDirectory: false,
        additionalDirs: [],
        gatewayState: 'unknown',
        currentActivity: null,
        lastEventAt: 0,
        permission: null,
        permissionDenied: null,
        error: null,
      } as never,
    ],
    activeTabId: TAB,
  })
}

const dispatch = (event: NormalizedEvent, tabId = TAB) =>
  useSessionStore.getState().handleNormalizedEvent(tabId, event)

const tab = () => useSessionStore.getState().tabs.find((t) => t.id === TAB)!
const messages = () => tab().messages

beforeEach(seedTab)

describe('text streaming', () => {
  it('starts a new assistant message on the first chunk', () => {
    dispatch({ type: 'text_chunk', text: 'Hello' })
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ role: 'assistant', content: 'Hello' })
  })

  it('appends later chunks to the same message', () => {
    dispatch({ type: 'text_chunk', text: 'Hel' })
    dispatch({ type: 'text_chunk', text: 'lo ' })
    dispatch({ type: 'text_chunk', text: 'world' })
    expect(messages()).toHaveLength(1)
    expect(messages()[0].content).toBe('Hello world')
  })

  it('replaces the message object rather than mutating it, so memo sees a change', () => {
    dispatch({ type: 'text_chunk', text: 'a' })
    const before = messages()[0]
    dispatch({ type: 'text_chunk', text: 'b' })
    const after = messages()[0]

    expect(after).not.toBe(before)
    expect(before.content).toBe('a')
    expect(after.content).toBe('ab')
  })

  it('starts a fresh message after a tool call rather than appending to the tool', () => {
    dispatch({ type: 'text_chunk', text: 'before' })
    dispatch({ type: 'tool_call', toolName: 'Read', toolId: 't1', index: 0 })
    dispatch({ type: 'text_chunk', text: 'after' })

    expect(messages().map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(messages()[2].content).toBe('after')
  })
})

describe('tool calls', () => {
  it('records a tool message in the running state', () => {
    dispatch({ type: 'tool_call', toolName: 'Bash', toolId: 't1', index: 0 })
    expect(messages()[0]).toMatchObject({ role: 'tool', toolName: 'Bash', toolStatus: 'running' })
  })

  it('accumulates streamed tool input', () => {
    dispatch({ type: 'tool_call', toolName: 'Bash', toolId: 't1', index: 0 })
    dispatch({ type: 'tool_call_update', toolId: 't1', partialInput: '{"cmd"' })
    dispatch({ type: 'tool_call_update', toolId: 't1', partialInput: ':"ls"}' })
    expect(messages()[0].toolInput).toBe('{"cmd":"ls"}')
  })

  it('replaces the tool message object when its input grows', () => {
    // Same reasoning as the text case: the row is memoized on the message
    // reference, so mutating in place leaves a half-written command on screen.
    dispatch({ type: 'tool_call', toolName: 'Bash', toolId: 't1', index: 0 })
    const before = messages()[0]
    dispatch({ type: 'tool_call_update', toolId: 't1', partialInput: 'x' })
    expect(messages()[0]).not.toBe(before)
  })

  it('replaces the tool message object when it completes', () => {
    dispatch({ type: 'tool_call', toolName: 'Bash', toolId: 't1', index: 0 })
    const before = messages()[0]
    dispatch({ type: 'tool_call_complete', index: 0 })
    expect(messages()[0]).not.toBe(before)
    expect(messages()[0].toolStatus).toBe('completed')
  })

  it('never rewrites a message belonging to an earlier render pass', () => {
    // Captures the array as a component would, then checks that a later event
    // has not reached back and edited it.
    dispatch({ type: 'tool_call', toolName: 'Bash', toolId: 't1', index: 0 })
    const snapshot = messages().map((m) => ({ ...m }))
    dispatch({ type: 'tool_call_update', toolId: 't1', partialInput: 'mutated' })
    dispatch({ type: 'tool_call_complete', index: 0 })

    expect(snapshot[0].toolInput ?? '').toBe('')
    expect(snapshot[0].toolStatus).toBe('running')
  })

  it('completes only the most recent running tool', () => {
    dispatch({ type: 'tool_call', toolName: 'Read', toolId: 't1', index: 0 })
    dispatch({ type: 'tool_call_complete', index: 0 })
    dispatch({ type: 'tool_call', toolName: 'Write', toolId: 't2', index: 1 })

    expect(messages().map((m) => m.toolStatus)).toEqual(['completed', 'running'])
  })

  it('ignores a completion with no running tool', () => {
    expect(() => dispatch({ type: 'tool_call_complete', index: 0 })).not.toThrow()
    expect(messages()).toHaveLength(0)
  })
})

describe('session init', () => {
  it('records the session identity', () => {
    dispatch({
      type: 'session_init',
      sessionId: 's-1',
      tools: ['Read'],
      model: 'claude-opus-5',
      mcpServers: [],
      skills: [],
      version: '1.0',
    })
    expect(tab()).toMatchObject({ claudeSessionId: 's-1', sessionModel: 'claude-opus-5', status: 'running' })
  })

  it('promotes the first queued prompt into the transcript', () => {
    useSessionStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === TAB ? { ...t, queuedPrompts: ['first', 'second'] } : t)),
    }))

    dispatch({
      type: 'session_init',
      sessionId: 's-1',
      tools: [],
      model: 'm',
      mcpServers: [],
      skills: [],
      version: '1',
    })

    expect(messages().map((m) => m.content)).toEqual(['first'])
    expect(tab().queuedPrompts).toEqual(['second'])
  })
})

describe('tab isolation', () => {
  it('drops an event addressed to an unknown tab', () => {
    dispatch({ type: 'text_chunk', text: 'stray' }, 'tab-that-does-not-exist')
    expect(messages()).toHaveLength(0)
  })

  it('never writes one tab’s output into another', () => {
    useSessionStore.setState((s) => ({
      tabs: [...s.tabs, { ...s.tabs[0], id: 'other-tab', messages: [] }],
    }))

    dispatch({ type: 'text_chunk', text: 'for the other tab' }, 'other-tab')

    expect(messages()).toHaveLength(0)
    expect(useSessionStore.getState().tabs.find((t) => t.id === 'other-tab')!.messages).toHaveLength(1)
  })

  it('leaves untouched tabs referentially identical so their subtrees do not re-render', () => {
    useSessionStore.setState((s) => ({
      tabs: [...s.tabs, { ...s.tabs[0], id: 'other-tab', messages: [] }],
    }))
    const otherBefore = useSessionStore.getState().tabs.find((t) => t.id === 'other-tab')

    dispatch({ type: 'text_chunk', text: 'hi' })

    expect(useSessionStore.getState().tabs.find((t) => t.id === 'other-tab')).toBe(otherBefore)
  })
})

describe('malformed events', () => {
  it('survives every event type with empty payloads', () => {
    const hostile: NormalizedEvent[] = [
      { type: 'text_chunk', text: '' } as never,
      { type: 'tool_call', toolName: '', toolId: '', index: 0 } as never,
      { type: 'tool_call_update', toolId: '', partialInput: '' } as never,
      { type: 'tool_call_complete', index: -1 } as never,
      { type: 'error', message: '', isError: true } as never,
      { type: 'rate_limit', status: '', resetsAt: 0, rateLimitType: '' } as never,
    ]
    for (const event of hostile) {
      expect(() => dispatch(event), `threw on ${event.type}`).not.toThrow()
    }
  })
})
