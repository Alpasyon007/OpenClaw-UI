/**
 * Session history listing for the tab history picker.
 *
 * The CLI writes one JSONL transcript per session at
 * `<agent-home>/projects/<encoded-cwd>/<uuid>.jsonl`. This turns that directory
 * into the `SessionMeta[]` the picker renders.
 *
 * This existed in the Electron main process and was lost in the saucer port,
 * which left the IPC handler returning a list of project *directories* — objects
 * with no `sessionId` at all. The picker read `session.sessionId.substring(0, 8)`
 * on those, threw, and took the whole React root down with it: the launcher went
 * blank and stayed blank, because nothing remounts a torn-down root.
 */
import { createReadStream } from 'fs'
import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { isAbsolute, join } from 'path'
import type { SessionMeta, SessionLoadMessage } from '../shared/types'
import { getAgentDataHomes } from './openclaw/runtime'
import { log as _log } from './logger'

function log(msg: string): void {
  _log('sessions', msg)
}

const IS_WIN = process.platform === 'win32'

/** Only files named as a UUID are transcripts; anything else is not ours. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Transcripts below this are empty shells, not conversations. */
const MIN_TRANSCRIPT_BYTES = 100

/** Most recent sessions shown in the picker. */
const MAX_SESSIONS = 20

/** Most turns hydrated into a resumed tab. A transcript here can reach 18MB. */
const MAX_TRANSCRIPT_MESSAGES = 500

/**
 * How far into a transcript to read for its metadata.
 *
 * The original read every line to find the last timestamp, which on this
 * machine means streaming an 18MB file to learn something `mtime` already
 * knows. Everything actually needed — the schema check, the slug, the first
 * user message — is at the head of the file.
 */
const MAX_METADATA_LINES = 400

function isSafeAbsolutePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !/[\0\r\n]/.test(p) && isAbsolute(p)
}

/**
 * Encode a working directory the way the CLI names its session folder.
 * Path separators and the Windows drive colon all collapse to '-', so
 * `C:\Dev\OpenClaw-UI` becomes `C--Dev-OpenClaw-UI`.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-')
}

/**
 * Locate a session directory for a project path.
 * Windows drive letters appear in either case on disk, so fall back to a
 * case-insensitive scan before giving up.
 */
export async function findSessionDir(cwd: string): Promise<string | null> {
  const encoded = encodeProjectDir(cwd)
  for (const home of getAgentDataHomes()) {
    const exact = join(home, 'projects', encoded)
    if (existsSync(exact)) return exact
  }
  if (!IS_WIN) return null

  const wanted = encoded.toLowerCase()
  for (const home of getAgentDataHomes()) {
    const root = join(home, 'projects')
    try {
      const match = (await readdir(root)).find((d) => d.toLowerCase() === wanted)
      if (match) return join(root, match)
    } catch {
      // Unreadable or absent projects root — try the next home.
    }
  }
  return null
}

interface TranscriptHead {
  validated: boolean
  slug: string | null
  firstMessage: string | null
}

/** Read the head of a transcript for the fields the picker displays. */
async function readTranscriptHead(filePath: string): Promise<TranscriptHead> {
  const meta: TranscriptHead = { validated: false, slug: null, firstMessage: null }
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream })
  let lines = 0
  try {
    for await (const line of rl) {
      if (++lines > MAX_METADATA_LINES) break
      try {
        const obj = JSON.parse(line) as {
          type?: string; uuid?: string; timestamp?: string; slug?: string
          message?: { content?: unknown }
        }
        // A transcript, not some other JSONL that happens to live here.
        if (!meta.validated && obj.type && obj.uuid && obj.timestamp) meta.validated = true
        if (obj.slug && !meta.slug) meta.slug = obj.slug
        if (obj.type === 'user' && !meta.firstMessage) {
          const content = obj.message?.content
          if (typeof content === 'string') {
            meta.firstMessage = content.substring(0, 100)
          } else if (Array.isArray(content)) {
            const textPart = (content as Array<{ type?: string; text?: string }>).find((p) => p?.type === 'text')
            meta.firstMessage = textPart?.text?.substring(0, 100) || null
          }
        }
      } catch {
        // A partial or non-JSON line proves nothing about the rest.
      }
      if (meta.validated && meta.slug && meta.firstMessage) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return meta
}

/**
 * Sessions for a project directory, most recent first.
 *
 * Returns an empty list rather than throwing: the picker renders this
 * directly, and an empty history is a normal state.
 */
export async function listSessions(projectPath?: string): Promise<SessionMeta[]> {
  try {
    const cwd = projectPath || process.cwd()
    if (!isSafeAbsolutePath(cwd)) {
      log(`rejected invalid projectPath: ${String(cwd)}`)
      return []
    }
    const sessionsDir = await findSessionDir(cwd)
    if (!sessionsDir) {
      log(`no session directory for ${encodeProjectDir(cwd)}`)
      return []
    }

    const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl'))
    const sessions: SessionMeta[] = []

    for (const file of files) {
      // The filename minus .jsonl is the canonical id for `--resume`.
      const sessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(sessionId)) continue

      const filePath = join(sessionsDir, file)
      try {
        const info = await stat(filePath)
        if (info.size < MIN_TRANSCRIPT_BYTES) continue
        const meta = await readTranscriptHead(filePath)
        if (!meta.validated) continue
        sessions.push({
          sessionId,
          slug: meta.slug,
          firstMessage: meta.firstMessage,
          // mtime is when the session was last written to, which is what the
          // picker sorts and labels by.
          lastTimestamp: info.mtime.toISOString(),
          size: info.size,
        })
      } catch (err) {
        log(`skipping ${file}: ${String(err)}`)
      }
    }

    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    log(`${sessions.length} session(s) in ${sessionsDir}`)
    return sessions.slice(0, MAX_SESSIONS)
  } catch (err) {
    log(`listSessions error: ${String(err)}`)
    return []
  }
}

/**
 * Read a local transcript into the messages the renderer hydrates a tab with.
 *
 * The IPC handler behind this used to join the *project* cwd with
 * `<id>.jsonl` — which is not where transcripts live — so every resume
 * ENOENTed. Worse, it answered `{ ok, content }` where the contract declares
 * `SessionLoadMessage[]`, so the renderer's `.map()` threw past its own
 * `.catch()` and the outer handler quietly built a second, unregistered tab.
 * Resuming a session has therefore been opening an empty conversation.
 *
 * Returns `[]` rather than throwing: an unreadable transcript is a normal
 * state, and the caller renders this directly.
 */
export async function readLocalTranscript(
  sessionId: string,
  projectPath?: string,
): Promise<SessionLoadMessage[]> {
  // A gateway session key ('agent:main:main') is not a transcript id, and on
  // Windows `agent:main:main.jsonl` names an NTFS alternate data stream rather
  // than a file. Reject anything that is not a UUID before it reaches join().
  if (!UUID_RE.test(String(sessionId ?? ''))) {
    log(`readLocalTranscript: not a transcript id: ${String(sessionId)}`)
    return []
  }
  const cwd = projectPath || process.cwd()
  if (!isSafeAbsolutePath(cwd)) return []
  const dir = await findSessionDir(cwd)
  if (!dir) {
    log(`readLocalTranscript: no session directory for ${encodeProjectDir(cwd)}`)
    return []
  }

  const filePath = join(dir, `${sessionId}.jsonl`)
  const out: SessionLoadMessage[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const line of rl) {
      try {
        const obj = JSON.parse(line) as {
          type?: string
          timestamp?: string
          message?: { content?: unknown }
        }
        if (obj.type !== 'user' && obj.type !== 'assistant') continue
        const timestamp = Date.parse(obj.timestamp ?? '') || 0
        const content = obj.message?.content
        if (typeof content === 'string') {
          if (content) out.push({ role: obj.type, content, timestamp })
        } else if (Array.isArray(content)) {
          const parts = content as Array<{ type?: string; text?: string; name?: string }>
          const text = parts
            .filter((p) => p?.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n\n')
            .trim()
          if (text) out.push({ role: obj.type, content: text, timestamp })
          for (const p of parts) {
            if (p?.type === 'tool_use' && p.name) {
              out.push({ role: 'tool', content: '', toolName: p.name, timestamp })
            }
          }
        }
        // Rolling window: an 18MB transcript must never be held in full just to
        // render its tail.
        while (out.length > MAX_TRANSCRIPT_MESSAGES) out.shift()
      } catch {
        // A partial or non-JSON line proves nothing about the rest.
      }
    }
  } catch (err) {
    log(`readLocalTranscript ${sessionId}: ${String(err)}`)
  } finally {
    rl.close()
    stream.destroy()
  }
  log(`readLocalTranscript ${sessionId}: ${out.length} message(s)`)
  return out
}
