import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectDir, readLocalTranscript } from '../../src/main/sessions'
import { deriveGatewayLabel, gatewaySessionLabel, isCluiSessionKey } from '../../src/shared/session-keys'

/**
 * Reading a local transcript back into a resumed tab.
 *
 * The handler behind this used to join the *project* cwd with `<id>.jsonl` —
 * which is not where transcripts live — and answer `{ ok, content }` where the
 * contract declares `SessionLoadMessage[]`. The renderer's `.map()` threw past
 * its own `.catch()`, the outer handler quietly built a second unregistered
 * tab, and resuming a session opened an empty conversation. Both halves of that
 * are asserted here: the right directory, and the declared return shape.
 *
 * The UUID guard is a security boundary, not a tidiness check. A gateway
 * session key like `agent:main:main` must never reach `join()` — on Windows
 * `agent:main:main.jsonl` names an NTFS alternate data stream, not a file.
 */

const UUID = '30088f4f-6234-4463-975b-b2253bf06736'

let home: string
let project: string

function writeTranscript(lines: unknown[]): void {
  const dir = join(home, 'projects', encodeProjectDir(project))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clui-home-'))
  project = mkdtempSync(join(tmpdir(), 'clui-project-'))
  process.env.OPENCLAW_HOME_DIR = home
})

afterEach(() => {
  delete process.env.OPENCLAW_HOME_DIR
  for (const dir of [home, project]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp dir must not fail the suite.
    }
  }
})

describe('readLocalTranscript', () => {
  it('reads from the agent home, not from the project directory', async () => {
    // The old handler looked here. Nothing must ever be read from it.
    writeFileSync(join(project, `${UUID}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'WRONG PLACE' } }), 'utf-8')
    writeTranscript([
      { type: 'user', timestamp: '2026-08-16T00:00:00.000Z', message: { content: 'hello' } },
      { type: 'assistant', timestamp: '2026-08-16T00:00:01.000Z', message: { content: 'hi' } },
    ])

    const messages = await readLocalTranscript(UUID, project)
    expect(messages.map((m) => m.content)).toEqual(['hello', 'hi'])
    expect(JSON.stringify(messages)).not.toContain('WRONG PLACE')
  })

  it('answers an array, which is what the contract has always declared', async () => {
    writeTranscript([{ type: 'user', message: { content: 'x' } }])
    const messages = await readLocalTranscript(UUID, project)
    expect(Array.isArray(messages)).toBe(true)
  })

  it('refuses a gateway session key before it can reach the filesystem', async () => {
    for (const key of ['agent:main:main', 'clui-abc', '', '../../etc/passwd', 'C:\\x']) {
      expect(await readLocalTranscript(key, project)).toEqual([])
    }
  })

  it('flattens text blocks and records tool names', async () => {
    writeTranscript([
      {
        type: 'assistant',
        timestamp: '2026-08-16T00:00:00.000Z',
        message: {
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      },
    ])
    const messages = await readLocalTranscript(UUID, project)
    expect(messages).toEqual([
      { role: 'assistant', content: 'part one\n\npart two', timestamp: Date.parse('2026-08-16T00:00:00.000Z') },
      { role: 'tool', content: '', toolName: 'Bash', timestamp: Date.parse('2026-08-16T00:00:00.000Z') },
    ])
  })

  it('skips a corrupt line without abandoning the rest of the file', async () => {
    const dir = join(home, 'projects', encodeProjectDir(project))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${UUID}.jsonl`),
      [JSON.stringify({ type: 'user', message: { content: 'before' } }), '{not json', JSON.stringify({ type: 'user', message: { content: 'after' } })].join('\n'),
      'utf-8',
    )
    const messages = await readLocalTranscript(UUID, project)
    expect(messages.map((m) => m.content)).toEqual(['before', 'after'])
  })

  it('keeps only the tail of a very long transcript', async () => {
    writeTranscript(
      Array.from({ length: 700 }, (_, i) => ({ type: 'user', message: { content: `m${i}` } })),
    )
    const messages = await readLocalTranscript(UUID, project)
    expect(messages).toHaveLength(500)
    expect(messages[messages.length - 1].content).toBe('m699')
  })

  it('returns [] rather than throwing when there is no transcript at all', async () => {
    expect(await readLocalTranscript(UUID, project)).toEqual([])
    expect(await readLocalTranscript(UUID, 'not-an-absolute-path')).toEqual([])
  })
})

describe('gateway session labels', () => {
  it('strips only the agent prefix', () => {
    expect(deriveGatewayLabel('agent:main:main')).toBe('main')
    expect(deriveGatewayLabel('agent:main:cron:99801675')).toBe('cron:99801675')
    expect(deriveGatewayLabel('no-colons-here')).toBe('no-colons-here')
    expect(deriveGatewayLabel('')).toBe('')
  })

  it('prefers the gateway’s own title, which only some sessions have', () => {
    expect(gatewaySessionLabel('agent:main:dashboard:9ce', 'Nova Node Permissions Issue')).toBe(
      'Nova Node Permissions Issue',
    )
    expect(gatewaySessionLabel('agent:main:main', null)).toBe('main')
    expect(gatewaySessionLabel('agent:main:main', '   ')).toBe('main')
  })

  it('shortens this app’s own keys, which the gateway never titles', () => {
    expect(isCluiSessionKey('agent:main:clui-a7105ce4-7dda-4e8b-adf9-9940e775fa40')).toBe(true)
    expect(gatewaySessionLabel('agent:main:clui-a7105ce4-7dda-4e8b-adf9-9940e775fa40', null)).toBe(
      'Tab a7105ce4',
    )
    expect(isCluiSessionKey('agent:main:main')).toBe(false)
  })
})
