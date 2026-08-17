import { describe, it, expect } from 'vitest'
import { ChatEventSchema } from '@openclaw/protocol'
import {
  emptyTranscript,
  applyChatEvent,
  applyHistory,
  applyToolEvent,
  addPendingUserMessage,
  settlePendingMessage,
} from './transcript'

const evt = (o: Record<string, unknown>) =>
  ChatEventSchema.parse({ runId: 'r1', sessionKey: 'agent:main:main', ...o })

describe('streaming deltas', () => {
  it('appends successive deltas into one row', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'Hello' }))
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: ' world' }))

    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('Hello world')
    expect(s.messages[0].status).toBe('streaming')
    expect(s.activeRunId).toBe('r1')
  })

  it('REPLACES rather than appends when replace is set', () => {
    // The single most consequential rule here. `replace` only fires when the
    // model rewrites text it already emitted, so appending passes every
    // happy-path test and silently duplicates real responses.
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'The answer is 41' }))
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'The answer is 42', replace: true }))

    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('The answer is 42')
    expect(s.messages[0].content).not.toContain('41')
  })

  it('never mutates a message in place', () => {
    // Rows are memoised on identity; an in-place append renders nothing.
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'a' }))
    const first = s.messages[0]
    const firstList = s.messages

    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'b' }))

    expect(s.messages[0]).not.toBe(first)
    expect(s.messages).not.toBe(firstList)
    expect(first.content).toBe('a')
  })

  it('returns the identical state for a no-op delta', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'x' }))
    const before = s
    const after = applyChatEvent(s, evt({ state: 'delta', deltaText: '' }))
    expect(after).toBe(before)
  })

  it('keeps concurrent runs in separate rows', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'first', runId: 'r1' }))
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'second', runId: 'r2' }))
    expect(s.messages).toHaveLength(2)
    expect(s.messages.map((m) => m.content)).toEqual(['first', 'second'])
  })
})

describe('terminal states', () => {
  it('marks a finished run complete and keeps its text', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'done thinking' }))
    s = applyChatEvent(s, evt({ state: 'final' }))

    expect(s.messages[0].content).toBe('done thinking')
    expect(s.messages[0].status).toBe('complete')
    expect(s.activeRunId).toBeNull()
  })

  it('names the outcome when a run produced no text', () => {
    // An empty assistant bubble reads as a bug rather than as a cancellation.
    let s = applyChatEvent(emptyTranscript(), evt({ state: 'aborted' }))
    expect(s.messages[0].content).toBe('(run cancelled)')

    s = applyChatEvent(emptyTranscript(), evt({ state: 'error' }))
    expect(s.messages[0].content).toBe('(the run failed)')
    expect(s.messages[0].status).toBe('error')
  })

  it('prefers the error message over a generic fallback', () => {
    const s = applyChatEvent(
      emptyTranscript(),
      evt({ state: 'error', errorMessage: 'rate limited', errorKind: 'rate_limit' }),
    )
    expect(s.messages[0].content).toBe('rate limited')
    expect(s.messages[0].errorKind).toBe('rate_limit')
  })

  it('keeps partial text when a run errors mid-stream', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'partial answer' }))
    s = applyChatEvent(s, evt({ state: 'error', errorMessage: 'connection lost' }))
    // Throwing away what the user already read would be worse than the error.
    expect(s.messages[0].content).toBe('partial answer')
    expect(s.messages[0].status).toBe('error')
  })

  it('does not clear the active run on a late event from an older run', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'old', runId: 'r1' }))
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'new', runId: 'r2' }))
    s = applyChatEvent(s, evt({ state: 'final', runId: 'r1' }))
    // r2 is still streaming; a straggler from r1 must not stop the spinner.
    expect(s.activeRunId).toBe('r2')
  })

  it('captures usage when reported', () => {
    const s = applyChatEvent(
      emptyTranscript(),
      evt({ state: 'final', usage: { input_tokens: 10, output_tokens: 5 } }),
    )
    expect(s.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })
})

describe('optimistic user messages', () => {
  it('shows immediately and settles on send', () => {
    let s = addPendingUserMessage(emptyTranscript(), 'local-1', 'hi there', 1000)
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'hi there', pending: true })

    s = settlePendingMessage(s, 'local-1', 'sent')
    expect(s.messages[0].pending).toBe(false)
    expect(s.messages[0].status).toBe('complete')
  })

  it('marks a failed send as an error rather than leaving it looking delivered', () => {
    let s = addPendingUserMessage(emptyTranscript(), 'local-1', 'hi', 1000)
    s = settlePendingMessage(s, 'local-1', 'failed')
    expect(s.messages[0].status).toBe('error')
  })

  it('ignores an unknown id', () => {
    const s = addPendingUserMessage(emptyTranscript(), 'a', 'x', 1)
    expect(settlePendingMessage(s, 'nope', 'sent')).toBe(s)
  })
})

describe('history', () => {
  it('maps user and assistant rows, string or parts', () => {
    const s = applyHistory(emptyTranscript(), [
      { role: 'user', content: 'question', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
    ])
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'question'],
      ['assistant', 'answer'],
    ])
  })

  it('drops rows that cannot be rendered', () => {
    const s = applyHistory(emptyTranscript(), [
      null,
      'not an object',
      { role: 'system', content: 'ignored' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'kept' },
    ])
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('kept')
  })

  it('preserves a still-streaming row across a history refresh', () => {
    // History is authoritative, but a run in flight has not been written to it
    // yet. Dropping the live row blanks the reply mid-sentence on reconnect.
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'streaming now' }))
    s = applyHistory(s, [{ role: 'user', content: 'earlier', timestamp: 1 }])

    expect(s.messages.map((m) => m.content)).toEqual(['earlier', 'streaming now'])
  })

  it('does not preserve a finished row, since history already has it', () => {
    let s = emptyTranscript()
    s = applyChatEvent(s, evt({ state: 'delta', deltaText: 'old reply' }))
    s = applyChatEvent(s, evt({ state: 'final' }))
    s = applyHistory(s, [{ role: 'assistant', content: 'old reply', timestamp: 1 }])

    expect(s.messages).toHaveLength(1)
  })

  it('never throws on a malformed page', () => {
    expect(() => applyHistory(emptyTranscript(), [undefined, 42, [], {}])).not.toThrow()
  })
})

describe('tool events', () => {
  const tool = (o: Record<string, unknown>) => o as never

  it('adds a running card', () => {
    const s = applyToolEvent(emptyTranscript(), tool({
      toolCallId: 'c1', name: 'Bash', phase: 'start', input: { command: 'ls -la' },
    }))
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ role: 'tool', toolName: 'Bash', status: 'streaming' })
    expect(s.messages[0].content).toBe('ls -la')
  })

  it('updates the same card rather than adding a second', () => {
    // A tool emits a start and then a completion for the SAME call. Appending
    // both leaves a duplicate card that never resolves.
    let s = applyToolEvent(emptyTranscript(), tool({ toolCallId: 'c1', name: 'Bash', phase: 'start' }))
    s = applyToolEvent(s, tool({ toolCallId: 'c1', name: 'Bash', phase: 'end', result: 'ok' }))
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].status).toBe('complete')
  })

  it('marks a failed tool as an error', () => {
    const s = applyToolEvent(emptyTranscript(), tool({ toolCallId: 'c1', name: 'Bash', error: 'nope' }))
    expect(s.messages[0].status).toBe('error')
  })

  it('places a tool BEFORE the assistant row of its run', () => {
    // The agent runs tools while composing its reply. Appending after would
    // show the reasoning before the work that produced it.
    let s = applyChatEvent(emptyTranscript(), evt({ state: 'delta', deltaText: 'thinking' }))
    s = applyToolEvent(s, tool({ toolCallId: 'c1', name: 'Read', runId: 'r1' }))
    expect(s.messages.map((m) => m.role)).toEqual(['tool', 'assistant'])
  })

  it('appends when its run has no assistant row yet', () => {
    const s = applyToolEvent(emptyTranscript(), tool({ toolCallId: 'c1', name: 'Read', runId: 'r9' }))
    expect(s.messages).toHaveLength(1)
  })

  it('summarises the field that identifies the work', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: 'npm test' }, 'npm test'],
      [{ file_path: '/a/b.ts' }, '/a/b.ts'],
      [{ pattern: 'TODO' }, 'TODO'],
      [{ url: 'https://x.dev' }, 'https://x.dev'],
    ]
    for (const [input, expected] of cases) {
      const s = applyToolEvent(emptyTranscript(), tool({ toolCallId: 'k', input }))
      expect(s.messages[0].content).toBe(expected)
    }
  })

  it('collapses whitespace and truncates a long summary', () => {
    const s = applyToolEvent(emptyTranscript(), tool({
      toolCallId: 'c1', input: { command: 'a\n\n   b' + 'x'.repeat(400) },
    }))
    expect(s.messages[0].content).not.toContain('\n')
    expect(s.messages[0].content.length).toBeLessThanOrEqual(161)
    expect(s.messages[0].content.endsWith('…')).toBe(true)
  })

  it('never throws on a malformed payload', () => {
    for (const bad of [{}, { input: 42 }, { input: [] }, { args: null }]) {
      expect(() => applyToolEvent(emptyTranscript(), tool(bad))).not.toThrow()
    }
  })
})
