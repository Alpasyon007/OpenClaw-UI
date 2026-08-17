import { describe, it, expect } from 'vitest'
import {
  ChatEventSchema,
  isTerminalChatState,
  availableDecisions,
  APPROVAL_DECISIONS,
  ExecApprovalRequestedSchema,
  ExecApprovalRequestSchema,
  CHAT_ERROR_KINDS,
} from './events'

describe('ChatEventSchema', () => {
  it('parses a delta', () => {
    const parsed = ChatEventSchema.safeParse({
      state: 'delta',
      runId: 'r1',
      sessionKey: 'agent:main:main',
      deltaText: 'hello',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.state).toBe('delta')
  })

  it('preserves replace:true', () => {
    // The whole streaming design turns on this flag. If it is dropped by the
    // schema, deltas that are replacements get appended and every revised
    // response is duplicated in the transcript.
    const parsed = ChatEventSchema.safeParse({
      state: 'delta',
      runId: 'r1',
      sessionKey: 'k',
      deltaText: 'corrected text',
      replace: true,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.state !== 'delta') return
    expect(parsed.data.replace).toBe(true)
  })

  it('defaults a missing deltaText to empty rather than failing', () => {
    const parsed = ChatEventSchema.safeParse({ state: 'delta', runId: 'r', sessionKey: 'k' })
    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.state !== 'delta') return
    expect(parsed.data.deltaText).toBe('')
  })

  it.each(['final', 'aborted', 'error'])('parses the %s terminal state', (state) => {
    const parsed = ChatEventSchema.safeParse({ state, runId: 'r', sessionKey: 'k' })
    expect(parsed.success).toBe(true)
  })

  it('accepts an errorKind outside the documented set', () => {
    // Modelled as a plain string on purpose: a new failure mode upstream must
    // not make the terminal event unparseable, which would leave the run
    // spinning in the UI forever.
    const parsed = ChatEventSchema.safeParse({
      state: 'error',
      runId: 'r',
      sessionKey: 'k',
      errorKind: 'invented_later',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown state', () => {
    expect(ChatEventSchema.safeParse({ state: 'thinking', runId: 'r', sessionKey: 'k' }).success).toBe(
      false,
    )
  })

  it('requires runId and sessionKey', () => {
    // Without both, an event cannot be routed to a conversation, and a
    // mis-routed delta writes one session's text into another.
    expect(ChatEventSchema.safeParse({ state: 'delta', sessionKey: 'k' }).success).toBe(false)
    expect(ChatEventSchema.safeParse({ state: 'delta', runId: 'r' }).success).toBe(false)
  })

  it('separates streaming from terminal states', () => {
    const delta = ChatEventSchema.parse({ state: 'delta', runId: 'r', sessionKey: 'k' })
    const final = ChatEventSchema.parse({ state: 'final', runId: 'r', sessionKey: 'k' })
    expect(isTerminalChatState(delta)).toBe(false)
    expect(isTerminalChatState(final)).toBe(true)
  })

  it('guards the guard: the error-kind set is non-trivial', () => {
    expect(CHAT_ERROR_KINDS.length).toBeGreaterThan(3)
  })
})

describe('availableDecisions', () => {
  it('offers all three when nothing is blocked', () => {
    expect(availableDecisions({})).toEqual([...APPROVAL_DECISIONS])
  })

  it('withholds a blocked decision', () => {
    // Under `ask: "always"` the host keeps prompting regardless of stored trust,
    // so allow-always is offered but would not be honoured. Showing the button
    // promises something the gateway will refuse.
    const decisions = availableDecisions({ unavailableDecisions: ['allow-always'] })
    expect(decisions).toEqual(['allow-once', 'deny'])
    expect(decisions).not.toContain('allow-always')
  })

  it('always leaves deny reachable in the common blocked case', () => {
    expect(availableDecisions({ unavailableDecisions: ['allow-always'] })).toContain('deny')
  })

  it('ignores an unrecognised entry in unavailableDecisions', () => {
    expect(availableDecisions({ unavailableDecisions: ['nonsense'] })).toEqual([
      ...APPROVAL_DECISIONS,
    ])
  })

  it('never throws when the wire disagrees with the type', () => {
    // These are shapes the compiler forbids but the gateway can still send, so
    // the cast is the point of the test rather than an oversight: this function
    // renders the approval buttons, and throwing here would leave a blocked
    // agent with no reachable answer at all.
    const malformed = [
      { unavailableDecisions: null },
      { unavailableDecisions: 'allow-always' },
      { unavailableDecisions: [null, 7] },
      {},
    ] as unknown as Parameters<typeof availableDecisions>[0][]

    for (const request of malformed) {
      expect(() => availableDecisions(request)).not.toThrow()
      expect(availableDecisions(request)).toContain('deny')
    }
  })
})

describe('ExecApprovalRequestedSchema', () => {
  it('parses a realistic request', () => {
    const parsed = ExecApprovalRequestedSchema.safeParse({
      id: 'appr-1',
      request: {
        id: 'appr-1',
        command: 'rm -rf build',
        commandArgv: ['rm', '-rf', 'build'],
        cwd: 'C:/Dev/OpenClaw-UI',
        nodeId: 'node-1',
        host: 'node',
        security: 'allowlist',
        ask: 'on-miss',
        warningText: 'recursive delete',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        commandSpans: [{ start: 0, end: 2, kind: 'binary' }],
        unavailableDecisions: ['allow-always'],
        systemRunPlan: { argv: ['rm', '-rf', 'build'], cwd: 'C:/Dev/OpenClaw-UI' },
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    })
    expect(parsed.success).toBe(true)
  })

  it('requires an id, since without one the approval cannot be answered', () => {
    expect(ExecApprovalRequestedSchema.safeParse({ request: {} }).success).toBe(false)
  })

  it('tolerates a sparse request', () => {
    // Approvals originate from several code paths and not all populate every
    // field. A missing `warningText` must not stop the user seeing the prompt.
    expect(ExecApprovalRequestedSchema.safeParse({ id: 'a', request: {} }).success).toBe(true)
  })

  it('passes unknown request fields through untouched', () => {
    // The gateway binds the request against mutation — it rejects the run if
    // anything changed between prepare and resolve. Dropping fields we do not
    // model would make a verbatim echo impossible.
    const parsed = ExecApprovalRequestSchema.safeParse({
      command: 'ls',
      someFutureField: { nested: true },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect((parsed.data as Record<string, unknown>).someFutureField).toEqual({ nested: true })
  })
})
