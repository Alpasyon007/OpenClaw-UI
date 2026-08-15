import { describe, expect, it } from 'vitest'
import {
  extractSessionId,
  isInputPrompt,
  isUiChrome,
  parseToolCallLine,
  redactArgs,
  stripAnsi,
} from '../../src/main/claude/pty-run-manager'

/**
 * The PTY path is the app's only source of assistant text, and it is entirely
 * heuristic: the CLI renders a full-screen Ink UI, and these functions decide
 * which of those lines are chrome and which are the answer. Every rule here is
 * a guess about what the CLI prints, so each one is also a chance to throw away
 * a real sentence.
 *
 * The suite is split accordingly: what the filters MUST catch, and what they
 * must NEVER catch. The second half is the one that matters — a false positive
 * is invisible in testing and looks like the model went quiet.
 */

describe('stripAnsi', () => {
  it('removes SGR colour sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('removes cursor movement and line clears', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Ghello')).toBe('hello')
  })

  it('removes private-mode sequences such as hide/show cursor', () => {
    expect(stripAnsi('\x1b[?25lhi\x1b[?25h')).toBe('hi')
  })

  it('removes OSC title sequences terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;window title\x07body')).toBe('body')
  })

  it('removes character-set selection', () => {
    expect(stripAnsi('\x1b(Btext')).toBe('text')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('just words, 100% of them')).toBe('just words, 100% of them')
  })

  it('preserves non-ASCII content', () => {
    expect(stripAnsi('\x1b[32m✓ café — 日本語\x1b[0m')).toBe('✓ café — 日本語')
  })

  it('is idempotent', () => {
    const once = stripAnsi('\x1b[31mred\x1b[0m')
    expect(stripAnsi(once)).toBe(once)
  })
})

describe('extractSessionId', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  it.each([
    `Session: ${uuid}`,
    `session_id: ${uuid}`,
    `session id: ${uuid}`,
    `Resuming session ${uuid}`,
  ])('finds the id in %s', (line) => {
    expect(extractSessionId(line)).toBe(uuid)
  })

  it('returns null when no session line is present', () => {
    expect(extractSessionId('some other output')).toBeNull()
  })

  it('returns null for a bare uuid with no label', () => {
    expect(extractSessionId(uuid)).toBeNull()
  })
})

describe('isInputPrompt', () => {
  it.each(['❯', '>', '$', '❯ ? for shortcuts', '  ❯  '])('treats %o as the prompt', (line) => {
    expect(isInputPrompt(line)).toBe(true)
  })

  it.each([
    '❯ actual user text',
    'The answer is > 5',
    '$ npm install',
  ])('does not treat %o as the prompt', (line) => {
    expect(isInputPrompt(line)).toBe(false)
  })
})

describe('isUiChrome — lines that must be filtered', () => {
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['banner', '🦞 OpenClaw v1'],
    ['box drawing', '╭─────────╮'],
    ['spinner', '⠋ working'],
    ['horizontal rule', '────────'],
    ['status bar', 'gateway connected | idle'],
    ['decoration only', '▪▪▪'],
  ])('filters %s', (_name, line) => {
    expect(isUiChrome(line)).toBe(true)
  })
})

describe('isUiChrome — assistant text that must survive', () => {
  /**
   * Each of these is an ordinary sentence an assistant could produce. They are
   * listed because the chrome filter matches on bare substrings — `thinking`,
   * `processing`, `/doctor`, `MCP server`, `Claude Max` — with no anchoring to
   * the start of a line or to a status-bar shape, so any answer that happens to
   * mention one of those words is dropped from the transcript entirely.
   */
  it.each([
    ['a word from the spinner vocabulary', 'I am processing the file now.'],
    ['the word thinking mid-sentence', 'Here is my thinking on the matter.'],
    ['a slash command in prose', 'Run /doctor to check your installation.'],
    ['a config topic', 'There may be a settings issue in your config.'],
    ['an MCP explanation', 'An MCP server exposes tools to the model.'],
    ['a plan mention', 'Claude Max includes higher limits.'],
    ['a shortcuts sentence', 'Press the key for shortcuts to see the list.'],
    ['a code fence line', 'const total = 4 - 2'],
    ['a normal answer', 'The function returns the sum of both arguments.'],
    ['a markdown bullet', '- first item'],
  ])('keeps %s', (_name, line) => {
    expect(isUiChrome(line), `dropped as chrome: ${line}`).toBe(false)
  })
})

describe('parseToolCallLine', () => {
  it('returns null for ordinary prose', () => {
    expect(parseToolCallLine('this is not a tool call')).toBeNull()
  })

  it('returns null for an empty line', () => {
    expect(parseToolCallLine('')).toBeNull()
  })
})

describe('redactArgs', () => {
  it('never lets a token reach a log line verbatim', () => {
    const secret = 'sk-ant-secret-value-0123456789'
    const redacted = redactArgs(['tui', '--token', secret, '--url', 'https://gw.example'])
    expect(redacted.join(' ')).not.toContain(secret)
  })

  it('never lets a password reach a log line verbatim', () => {
    const secret = 'hunter2-correct-horse'
    expect(redactArgs(['tui', '--password', secret]).join(' ')).not.toContain(secret)
  })

  it('leaves non-sensitive arguments readable', () => {
    expect(redactArgs(['tui', '--message', 'hello'])).toContain('hello')
  })

  it('returns a new array rather than mutating the callers', () => {
    const args = ['tui', '--token', 'abc']
    const out = redactArgs(args)
    expect(args).toEqual(['tui', '--token', 'abc'])
    expect(out).not.toBe(args)
  })
})
