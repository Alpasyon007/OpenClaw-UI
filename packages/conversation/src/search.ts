/**
 * Searching a transcript.
 *
 * Substring, case-insensitive, no regex. That is a decision rather than a
 * shortcut: the query comes from a phone keyboard, and a user typing `c++` or
 * `$1.50` into a box that compiles regex gets either an error or silently wrong
 * results. Nothing here ever constructs a `RegExp` from user input.
 */
import type { TranscriptMessage } from './transcript'

export interface SearchHit {
  message: TranscriptMessage
  /** Index into the array that was searched, for scroll-to. */
  index: number
  /** Character offset of the first match within `message.content`. */
  offset: number
  /** A window of surrounding text with the match inside it. */
  snippet: string
  /** Where the match sits within `snippet`, for highlighting. */
  snippetOffset: number
}

const SNIPPET_RADIUS = 48

/**
 * Every message containing `query`, in transcript order.
 *
 * An empty or whitespace-only query returns nothing rather than everything —
 * a search box that shows the entire transcript the moment it is focused looks
 * broken, and "no query" is not the same statement as "no filter".
 */
export function searchMessages(
  messages: readonly TranscriptMessage[],
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const hits: SearchHit[] = []
  messages.forEach((message, index) => {
    const haystack = message.content.toLowerCase()
    const offset = haystack.indexOf(needle)
    if (offset < 0) return

    const start = Math.max(0, offset - SNIPPET_RADIUS)
    const end = Math.min(message.content.length, offset + needle.length + SNIPPET_RADIUS)
    // Collapsing whitespace *after* slicing keeps `snippetOffset` honest only if
    // the collapse cannot shift the match, so the leading segment is measured
    // post-collapse rather than assumed.
    const leading = collapse(message.content.slice(start, offset))
    const matched = message.content.slice(offset, offset + needle.length)
    const trailing = collapse(message.content.slice(offset + needle.length, end))

    const prefix = start > 0 ? '…' : ''
    const suffix = end < message.content.length ? '…' : ''

    hits.push({
      message,
      index,
      offset,
      snippet: `${prefix}${leading}${matched}${trailing}${suffix}`,
      snippetOffset: prefix.length + leading.length,
    })
  })

  return hits
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * Split text into alternating non-matching and matching runs.
 *
 * Returned as a list of segments rather than as HTML or markup, because the
 * caller renders into React Native `<Text>` children and any string-level
 * highlighting would have to be parsed back out again.
 */
export function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]

  const segments: Array<{ text: string; match: boolean }> = []
  const haystack = text.toLowerCase()
  let cursor = 0

  for (;;) {
    const at = haystack.indexOf(needle, cursor)
    if (at < 0) break
    if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false })
    segments.push({ text: text.slice(at, at + needle.length), match: true })
    cursor = at + needle.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments.length > 0 ? segments : [{ text, match: false }]
}

/**
 * Filter a list of rows by a query over chosen fields.
 *
 * Used for the session list, where the useful thing to match is the label *or*
 * the raw key — a user searching `cron` means the display name, one searching
 * `agent:main` means the key, and matching only one of them makes the box feel
 * broken half the time.
 */
export function filterByFields<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => Array<string | null | undefined>,
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    fields(row).some((value) => (value ?? '').toLowerCase().includes(needle)),
  )
}
