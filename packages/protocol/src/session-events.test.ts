import { describe, it, expect } from 'vitest'
import {
  SessionToolEventSchema,
  toolName,
  toolCallKey,
  toolPhase,
} from './session-events'

const evt = (o: Record<string, unknown>) => SessionToolEventSchema.parse(o)

describe('SessionToolEventSchema', () => {
  it('parses a realistic start event', () => {
    const e = evt({
      sessionKey: 'agent:main:main',
      toolCallId: 'call-1',
      name: 'Bash',
      phase: 'start',
      input: { command: 'ls -la' },
    })
    expect(toolName(e)).toBe('Bash')
    expect(toolPhase(e)).toBe('running')
  })

  it('keeps fields it does not model', () => {
    // Tool payloads are shaped by whichever tool ran, and plugins add more.
    // Dropping unknown fields would lose exactly what a user wants to see.
    const e = evt({ name: 'CustomPluginTool', somethingNovel: { nested: 1 } })
    expect((e as Record<string, unknown>).somethingNovel).toEqual({ nested: 1 })
  })

  it('never rejects a sparse event', () => {
    expect(SessionToolEventSchema.safeParse({}).success).toBe(true)
  })

  it.each([null, 42, 'text', []])('rejects non-objects like %s without throwing', (input) => {
    expect(() => SessionToolEventSchema.safeParse(input)).not.toThrow()
  })
})

describe('toolName', () => {
  it('prefers name, falls back to tool, then a generic label', () => {
    expect(toolName(evt({ name: 'Read', tool: 'other' }))).toBe('Read')
    expect(toolName(evt({ tool: 'Grep' }))).toBe('Grep')
    // An unnamed card is still better than no card.
    expect(toolName(evt({}))).toBe('tool')
  })
})

describe('toolCallKey', () => {
  it('prefers toolCallId, then id', () => {
    expect(toolCallKey(evt({ toolCallId: 'a', id: 'b' }))).toBe('a')
    expect(toolCallKey(evt({ id: 'b' }))).toBe('b')
  })

  it('still yields a stable key with no ids', () => {
    // Without this, every event appends a new card instead of updating one.
    expect(toolCallKey(evt({ name: 'Bash', seq: 3 }))).toBe('Bash:3')
  })

  it('correlates a start with its completion', () => {
    const start = evt({ toolCallId: 'call-9', name: 'Bash', phase: 'start' })
    const end = evt({ toolCallId: 'call-9', name: 'Bash', phase: 'end', result: 'ok' })
    expect(toolCallKey(start)).toBe(toolCallKey(end))
  })
})

describe('toolPhase', () => {
  it.each([
    ['phase start', { phase: 'start' }, 'running'],
    ['status running', { status: 'running' }, 'running'],
    ['phase end', { phase: 'end' }, 'complete'],
    ['status ok', { status: 'ok' }, 'complete'],
    ['status complete', { status: 'complete' }, 'complete'],
    ['an error field', { error: 'boom' }, 'error'],
    ['phase error', { phase: 'error' }, 'error'],
    ['status failed', { status: 'failed' }, 'error'],
  ])('maps %s to %s', (_label, payload, expected) => {
    expect(toolPhase(evt(payload))).toBe(expected)
  })

  it('treats a bare result as completion', () => {
    // Some tools report completion only by carrying a result. Requiring an
    // explicit phase would leave those cards spinning forever.
    expect(toolPhase(evt({ result: 'done' }))).toBe('complete')
  })

  it('treats an unknown payload as still running rather than finished', () => {
    // Erring toward "running" is recoverable — the next event corrects it.
    // Erring toward "complete" strands a live tool looking finished.
    expect(toolPhase(evt({}))).toBe('running')
  })

  it('lets an error outrank a completion signal', () => {
    expect(toolPhase(evt({ phase: 'end', error: 'nope' }))).toBe('error')
  })
})
