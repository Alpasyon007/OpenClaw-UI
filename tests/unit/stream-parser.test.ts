import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { StreamParser } from '../../src/main/stream-parser'

/**
 * The parser sits between a child process's stdout and everything else. Its
 * only hard requirement is that a JSON object split across two reads still
 * arrives as one event — the OS decides where chunk boundaries fall, so a
 * parser that assumes whole lines works right up until output gets long.
 */

function collect(parser: StreamParser) {
  const events: unknown[] = []
  const errors: string[] = []
  parser.on('event', (e) => events.push(e))
  parser.on('parse-error', (line: string) => errors.push(line))
  return { events, errors }
}

describe('StreamParser', () => {
  it('emits one event per complete line', () => {
    const p = new StreamParser()
    const { events } = collect(p)
    p.feed('{"type":"a"}\n{"type":"b"}\n')
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('holds back a trailing partial line until it completes', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed('{"type":"a"}\n{"ty')
    expect(events).toEqual([{ type: 'a' }])
    expect(errors).toEqual([])

    p.feed('pe":"b"}\n')
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('reassembles an object split across many chunks', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    const payload = JSON.stringify({ type: 'result', result: 'x'.repeat(500) }) + '\n'
    for (const ch of payload) p.feed(ch)
    expect(errors).toEqual([])
    expect(events).toHaveLength(1)
    expect((events[0] as { result: string }).result).toHaveLength(500)
  })

  it('survives a CRLF stream without corrupting the payload', () => {
    // Windows PTYs and pipes both produce \r\n. JSON.parse tolerates the
    // trailing \r only because the parser trims; this pins that behaviour.
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed('{"type":"a"}\r\n{"type":"b"}\r\n')
    expect(errors).toEqual([])
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('reports a non-JSON line without throwing or dropping the stream', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed('warning: something on stderr\n{"type":"a"}\n')
    expect(errors).toEqual(['warning: something on stderr'])
    expect(events).toEqual([{ type: 'a' }])
  })

  it('ignores blank and whitespace-only lines', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed('\n   \n\t\n{"type":"a"}\n')
    expect(errors).toEqual([])
    expect(events).toEqual([{ type: 'a' }])
  })

  it('emits the final line on flush when the stream ends unterminated', () => {
    const p = new StreamParser()
    const { events } = collect(p)
    p.feed('{"type":"a"}')
    expect(events).toEqual([])
    p.flush()
    expect(events).toEqual([{ type: 'a' }])
  })

  it('does not re-emit the buffer on a second flush', () => {
    const p = new StreamParser()
    const { events } = collect(p)
    p.feed('{"type":"a"}')
    p.flush()
    p.flush()
    expect(events).toHaveLength(1)
  })

  it('reports an unterminated partial line on flush rather than swallowing it', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed('{"type":"trunc')
    p.flush()
    expect(events).toEqual([])
    expect(errors).toEqual(['{"type":"trunc'])
  })

  it('handles a line containing an escaped newline inside a string', () => {
    const p = new StreamParser()
    const { events, errors } = collect(p)
    p.feed(JSON.stringify({ type: 'x', text: 'line one\nline two' }) + '\n')
    expect(errors).toEqual([])
    expect((events[0] as { text: string }).text).toBe('line one\nline two')
  })

  it('pipes a readable stream and flushes on end', async () => {
    const source = new PassThrough()
    const p = StreamParser.fromStream(source)
    const { events } = collect(p)

    source.write('{"type":"a"}\n{"type":"b"}')
    source.end()
    await new Promise((r) => source.on('end', r))
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })
})
