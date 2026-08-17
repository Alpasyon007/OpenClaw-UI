import { describe, expect, it } from 'vitest'
import { filterByFields, highlightSegments, searchMessages } from './search'
import type { TranscriptMessage } from './transcript'

const message = (id: string, content: string, role: TranscriptMessage['role'] = 'user'): TranscriptMessage => ({
  id,
  role,
  content,
  status: 'complete',
  timestamp: 0,
})

describe('searchMessages', () => {
  it('matches case-insensitively and reports the transcript index', () => {
    const messages = [message('a', 'Hello there'), message('b', 'Goodbye THERE')]
    const hits = searchMessages(messages, 'there')
    expect(hits.map((h) => h.index)).toEqual([0, 1])
  })

  it('returns nothing for an empty query rather than everything', () => {
    // A search box that shows the whole transcript the moment it is focused
    // looks broken.
    expect(searchMessages([message('a', 'x')], '   ')).toEqual([])
  })

  it('builds a snippet with the match inside it, marked at the right offset', () => {
    const long = `${'x'.repeat(200)}needle${'y'.repeat(200)}`
    const [hit] = searchMessages([message('a', long)], 'needle')
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet.slice(hit.snippetOffset, hit.snippetOffset + 6)).toBe('needle')
  })

  it('keeps the marked offset correct after whitespace is collapsed', () => {
    const content = 'lots   of \n\n  space before needle here'
    const [hit] = searchMessages([message('a', content)], 'needle')
    expect(hit.snippet.slice(hit.snippetOffset, hit.snippetOffset + 6)).toBe('needle')
  })

  it('treats regex metacharacters as literal text', () => {
    // The query comes from a phone keyboard; compiling it as a regex would
    // either throw or silently return the wrong rows.
    const messages = [message('a', 'the cost was $1.50 (net)'), message('b', 'unrelated')]
    expect(searchMessages(messages, '$1.50').map((h) => h.index)).toEqual([0])
    expect(searchMessages(messages, '(net)').map((h) => h.index)).toEqual([0])
    expect(searchMessages(messages, 'c++')).toEqual([])
  })
})

describe('highlightSegments', () => {
  it('alternates matched and unmatched runs', () => {
    expect(highlightSegments('abcABCabc', 'abc')).toEqual([
      { text: 'abc', match: true },
      { text: 'ABC', match: true },
      { text: 'abc', match: true },
    ])
  })

  it('preserves the original casing of a matched run', () => {
    const segments = highlightSegments('Hello World', 'world')
    expect(segments.find((s) => s.match)?.text).toBe('World')
  })

  it('returns the whole string unmarked for an empty query', () => {
    expect(highlightSegments('abc', '')).toEqual([{ text: 'abc', match: false }])
  })
})

describe('filterByFields', () => {
  const rows = [
    { key: 'agent:main:cron:1', name: 'Daily briefing' },
    { key: 'agent:main:clui-abc', name: null },
  ]

  it('matches any of the supplied fields', () => {
    expect(filterByFields(rows, 'cron', (r) => [r.key, r.name])).toHaveLength(1)
    expect(filterByFields(rows, 'daily', (r) => [r.key, r.name])).toHaveLength(1)
  })

  it('returns a copy of everything for an empty query', () => {
    const result = filterByFields(rows, '  ', (r) => [r.key])
    expect(result).toEqual(rows)
    expect(result).not.toBe(rows)
  })

  it('tolerates null and undefined fields', () => {
    expect(() => filterByFields(rows, 'x', (r) => [r.name, undefined])).not.toThrow()
  })
})
