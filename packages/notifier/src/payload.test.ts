import { describe, it, expect } from 'vitest'
import { ChatEventSchema, ExecApprovalRequestedSchema } from '@openclaw/protocol'
import { approvalNotification, runNotification, assertNoContentLeak } from './payload'

const approval = (overrides: Record<string, unknown> = {}) =>
  ExecApprovalRequestedSchema.parse({
    id: 'appr-123456',
    request: {
      id: 'appr-123456',
      command: 'rm -rf /home/node/very-secret-project',
      commandArgv: ['rm', '-rf', '/home/node/very-secret-project'],
      cwd: '/home/node/very-secret-project',
      warningText: 'recursive delete of a project directory',
      sessionKey: 'agent:main:main',
      agentId: 'main',
      ...overrides,
    },
  })

const chat = (o: Record<string, unknown>) =>
  ChatEventSchema.parse({ runId: 'run-abcdef123', sessionKey: 'agent:main:main', ...o })

describe('approvalNotification', () => {
  it('carries ids, not content', () => {
    const n = approvalNotification(approval())
    expect(n.data.approvalId).toBe('appr-123456')
    expect(n.data.sessionKey).toBe('agent:main:main')
  })

  it('never puts the command anywhere in the payload', () => {
    // This is the load-bearing test. A push payload is readable on a lock
    // screen and retained by the OS outside the app's control.
    const n = approvalNotification(approval())
    const serialized = JSON.stringify(n)
    expect(serialized).not.toContain('rm -rf')
    expect(serialized).not.toContain('very-secret-project')
    expect(serialized).not.toContain('recursive delete')
  })

  it('keeps the visible text generic', () => {
    const n = approvalNotification(approval())
    expect(n.title).toBe('Approval needed')
    expect(n.body).not.toContain('rm')
  })

  it('collapses on the approval id', () => {
    expect(approvalNotification(approval()).collapseKey).toBe('approval:appr-123456')
  })

  it('survives a sparse request', () => {
    const sparse = ExecApprovalRequestedSchema.parse({ id: 'a1', request: {} })
    expect(() => approvalNotification(sparse)).not.toThrow()
  })
})

describe('runNotification', () => {
  it('ignores deltas — a phone must not buzz per token', () => {
    expect(runNotification(chat({ state: 'delta', deltaText: 'hello' }))).toBeNull()
  })

  it('ignores aborted runs, which the user cancelled themselves', () => {
    expect(runNotification(chat({ state: 'aborted' }))).toBeNull()
  })

  it('notifies on completion and failure', () => {
    expect(runNotification(chat({ state: 'final' }))?.kind).toBe('run-complete')
    expect(runNotification(chat({ state: 'error' }))?.kind).toBe('run-failed')
  })

  it('never carries the error message', () => {
    const n = runNotification(
      chat({ state: 'error', errorMessage: 'secret internal failure detail here' }),
    )
    expect(JSON.stringify(n)).not.toContain('secret internal failure')
  })

  it('collapses per run so repeated updates supersede', () => {
    expect(runNotification(chat({ state: 'final' }))?.collapseKey).toBe('run:run-abcdef123')
  })
})

describe('assertNoContentLeak', () => {
  it('passes a clean notification', () => {
    const source = approval()
    expect(() => assertNoContentLeak(approvalNotification(source), source)).not.toThrow()
  })

  it('throws when a payload embeds source content', () => {
    // Simulates the mistake this guard exists to catch: someone "helpfully"
    // putting the command in the body so the notification is more useful.
    const source = approval()
    const leaking = {
      ...approvalNotification(source),
      body: 'Run rm -rf /home/node/very-secret-project?',
    }
    expect(() => assertNoContentLeak(leaking, source)).toThrow(/leak/)
  })

  it('allows ids that legitimately appear in both', () => {
    const source = approval()
    const n = approvalNotification(source)
    // sessionKey is long enough to trip a naive check, but it is a pointer.
    expect(n.data.sessionKey).toBe('agent:main:main')
    expect(() => assertNoContentLeak(n, source)).not.toThrow()
  })

  it('never throws on a malformed source', () => {
    const n = approvalNotification(approval())
    for (const source of [null, undefined, 42, 'text', [], {}]) {
      expect(() => assertNoContentLeak(n, source)).not.toThrow()
    }
  })

  it('handles deeply nested sources without recursing forever', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 50; i++) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    const n = approvalNotification(approval())
    expect(() => assertNoContentLeak(n, deep)).not.toThrow()
  })
})
