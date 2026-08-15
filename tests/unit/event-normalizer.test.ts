import { describe, expect, it } from 'vitest'
import { normalize } from '../../src/main/claude/event-normalizer'
import type { ClaudeEvent } from '../../src/shared/types'

/**
 * The normalizer is the seam between whatever the CLI decides to emit and the
 * fixed event vocabulary the store reduces over. Its contract is total: any
 * input, however malformed, yields an array — never a throw, because a throw
 * here kills the run manager mid-stream and strands the tab.
 */

const raw = (e: unknown) => normalize(e as ClaudeEvent)

describe('normalize — totality', () => {
  const hostile: unknown[] = [
    { type: 'entirely_unknown' },
    { type: 'system' },
    { type: 'system', subtype: 'not-init' },
    { type: 'stream_event' },
    { type: 'stream_event', event: { type: 'unknown_sub' } },
    { type: 'result' },
    { type: 'rate_limit_event' },
    { type: 'permission_request' },
    {},
  ]

  for (const input of hostile) {
    it(`returns an array for ${JSON.stringify(input)}`, () => {
      const out = raw(input)
      expect(Array.isArray(out)).toBe(true)
    })
  }
})

describe('session_init', () => {
  it('carries the session identity through', () => {
    expect(
      raw({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        tools: ['Read'],
        model: 'claude-opus-5',
        mcp_servers: ['a'],
        skills: ['s'],
        claude_code_version: '2.0.0',
      }),
    ).toEqual([
      {
        type: 'session_init',
        sessionId: 'sess-1',
        tools: ['Read'],
        model: 'claude-opus-5',
        mcpServers: ['a'],
        skills: ['s'],
        version: '2.0.0',
      },
    ])
  })

  it('substitutes defaults for absent optional fields', () => {
    const [event] = raw({ type: 'system', subtype: 'init', session_id: 's' }) as any[]
    expect(event).toMatchObject({
      tools: [],
      mcpServers: [],
      skills: [],
      model: 'unknown',
      version: 'unknown',
    })
  })

  it('ignores a non-init system event', () => {
    expect(raw({ type: 'system', subtype: 'compact_boundary' })).toEqual([])
  })
})

describe('stream events', () => {
  it('maps a text delta to a text chunk', () => {
    expect(
      raw({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } }),
    ).toEqual([{ type: 'text_chunk', text: 'hi' }])
  })

  it('preserves an empty text delta rather than dropping it', () => {
    expect(
      raw({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } } }),
    ).toEqual([{ type: 'text_chunk', text: '' }])
  })

  it('maps a tool_use block start to a tool call', () => {
    expect(
      raw({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } },
      }),
    ).toEqual([{ type: 'tool_call', toolName: 'Read', toolId: 'tu_1', index: 2 }])
  })

  it('emits nothing for a text block start', () => {
    expect(
      raw({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
    ).toEqual([])
  })

  it('maps an input_json delta to a tool call update', () => {
    expect(
      raw({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } } }),
    ).toEqual([{ type: 'tool_call_update', toolId: '', partialInput: '{"a"' }])
  })

  it('carries the block index on completion so the caller can associate it', () => {
    expect(raw({ type: 'stream_event', event: { type: 'content_block_stop', index: 3 } })).toEqual([
      { type: 'tool_call_complete', index: 3 },
    ])
  })

  it('drops purely structural message events', () => {
    for (const t of ['message_start', 'message_delta', 'message_stop']) {
      expect(raw({ type: 'stream_event', event: { type: t } })).toEqual([])
    }
  })
})

describe('result', () => {
  it('reports an errored result as an error event', () => {
    expect(raw({ type: 'result', is_error: true, result: 'boom', session_id: 's' })).toEqual([
      { type: 'error', message: 'boom', isError: true, sessionId: 's' },
    ])
  })

  it('treats subtype "error" as an error even when is_error is absent', () => {
    const [event] = raw({ type: 'result', subtype: 'error', result: 'nope' }) as any[]
    expect(event.type).toBe('error')
  })

  it('falls back to a message when an errored result carries no text', () => {
    const [event] = raw({ type: 'result', is_error: true }) as any[]
    expect(event.message).toBe('Unknown error')
  })

  it('normalizes a successful result with its usage figures', () => {
    expect(
      raw({
        type: 'result',
        result: 'done',
        total_cost_usd: 0.5,
        duration_ms: 1200,
        num_turns: 3,
        usage: { input_tokens: 10 },
        session_id: 's',
      }),
    ).toEqual([
      {
        type: 'task_complete',
        result: 'done',
        costUsd: 0.5,
        durationMs: 1200,
        numTurns: 3,
        usage: { input_tokens: 10 },
        sessionId: 's',
      },
    ])
  })

  it('zero-fills missing cost and duration rather than emitting undefined', () => {
    const [event] = raw({ type: 'result', result: 'ok' }) as any[]
    expect(event).toMatchObject({ costUsd: 0, durationMs: 0, numTurns: 0, usage: {} })
  })

  it('attaches permission denials when the CLI reports any', () => {
    const [event] = raw({
      type: 'result',
      result: 'ok',
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu_9' }],
    }) as any[]
    expect(event.permissionDenials).toEqual([{ toolName: 'Bash', toolUseId: 'tu_9' }])
  })

  it('omits the denials key entirely when the list is empty', () => {
    const [event] = raw({ type: 'result', result: 'ok', permission_denials: [] }) as any[]
    expect('permissionDenials' in event).toBe(false)
  })

  it('ignores a denials field that is not an array', () => {
    const [event] = raw({ type: 'result', result: 'ok', permission_denials: 'nope' }) as any[]
    expect('permissionDenials' in event).toBe(false)
  })
})

describe('rate limit', () => {
  it('flattens the nested rate limit payload', () => {
    expect(
      raw({ type: 'rate_limit_event', rate_limit_info: { status: 'throttled', resetsAt: 123, rateLimitType: 'tokens' } }),
    ).toEqual([{ type: 'rate_limit', status: 'throttled', resetsAt: 123, rateLimitType: 'tokens' }])
  })

  it('emits nothing when the info block is absent', () => {
    expect(raw({ type: 'rate_limit_event' })).toEqual([])
  })
})

describe('permission request', () => {
  it('projects the tool and its options', () => {
    expect(
      raw({
        type: 'permission_request',
        question_id: 'q1',
        tool: { name: 'Bash', description: 'run it', input: { command: 'ls' } },
        options: [{ id: 'allow', label: 'Allow', kind: 'accept' }],
      }),
    ).toEqual([
      {
        type: 'permission_request',
        questionId: 'q1',
        toolName: 'Bash',
        toolDescription: 'run it',
        toolInput: { command: 'ls' },
        options: [{ id: 'allow', label: 'Allow', kind: 'accept' }],
      },
    ])
  })

  it('degrades to a named-unknown tool with no options', () => {
    const [event] = raw({ type: 'permission_request', question_id: 'q1' }) as any[]
    expect(event).toMatchObject({ toolName: 'unknown', options: [] })
  })
})
