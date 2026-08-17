import { describe, expect, it } from 'vitest'
import { exportFilename, toMarkdown, toPlainText } from './export'
import type { TranscriptMessage } from './transcript'

const NOW = Date.UTC(2026, 7, 17, 12, 30, 0)

const message = (
  id: string,
  role: TranscriptMessage['role'],
  content: string,
  extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({ id, role, content, status: 'complete', timestamp: 0, ...extra })

const base = { sessionKey: 'agent:main:demo', now: NOW }

describe('exportFilename', () => {
  it('replaces every character a filesystem or share sheet might reject', () => {
    // Session keys contain colons, which are a path separator on one platform
    // and illegal in a filename on another.
    const name = exportFilename('agent:main:clui-abc', NOW)
    expect(name).not.toMatch(/[:*?"<>|]/)
    expect(name.startsWith('openclaw-agent-main-clui-abc-')).toBe(true)
    expect(name.endsWith('.md')).toBe(true)
  })

  it('never produces a bare extension for an unusable key', () => {
    expect(exportFilename('::::', NOW)).toContain('session')
  })
})

describe('toMarkdown', () => {
  it('emits assistant markdown verbatim and fences user text', () => {
    const out = toMarkdown(
      [message('a', 'user', '# not a heading'), message('b', 'assistant', '# a real heading')],
      base,
    )
    // The user's `#` must not become a heading; the assistant's must stay one.
    expect(out).toContain('```text\n# not a heading\n```')
    expect(out).toContain('\n# a real heading\n')
  })

  it('neutralises a closing fence inside user text', () => {
    // Otherwise the block ends early and the rest of the transcript renders as
    // markdown — the exact injection the fencing exists to prevent.
    const out = toMarkdown([message('a', 'user', 'see ```\n# pwned')], base)
    expect(out).not.toContain('\nsee ```\n')
    expect(out.split('```').length - 1).toBe(2)
  })

  it('omits tool rows unless asked for them', () => {
    const messages = [message('t', 'tool', 'ls -la', { toolName: 'Bash' })]
    expect(toMarkdown(messages, base)).not.toContain('Bash')
    expect(toMarkdown(messages, { ...base, includeTools: true })).toContain('Bash')
  })

  it('labels a cost figure as an estimate', () => {
    const out = toMarkdown([message('a', 'user', 'hi')], {
      ...base,
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1_000_000 },
    })
    expect(out).toMatch(/estimated \$/)
  })

  it('reports tokens with no cost when the model has no known rate', () => {
    const out = toMarkdown([message('a', 'user', 'hi')], {
      ...base,
      model: 'mystery',
      usage: { input_tokens: 5000 },
    })
    expect(out).toContain('Tokens: 5.0k')
    expect(out).not.toContain('estimated')
  })

  it('uses the theme’s assistant name', () => {
    const out = toMarkdown([message('a', 'assistant', 'hello')], {
      ...base,
      assistantName: 'Aria',
    })
    expect(out).toContain('### Aria')
  })

  it('skips empty messages rather than emitting blank sections', () => {
    const out = toMarkdown([message('a', 'assistant', '   ')], base)
    expect(out).not.toContain('### Assistant')
  })

  it('is reproducible for a given `now`', () => {
    const a = toMarkdown([message('a', 'user', 'hi')], base)
    const b = toMarkdown([message('a', 'user', 'hi')], base)
    expect(a).toBe(b)
  })
})

describe('toPlainText', () => {
  it('renders one labelled line per message with no markup', () => {
    const out = toPlainText(
      [message('a', 'user', 'question'), message('b', 'assistant', 'answer')],
      { ...base, assistantName: 'Aria' },
    )
    expect(out).toBe('You: question\n\nAria: answer')
  })
})
