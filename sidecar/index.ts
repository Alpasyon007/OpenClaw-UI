// Node sidecar: the real OpenClaw backend, minus Electron.
//
// Under Electron, src/main/index.ts registered 58 channels and ALSO owned the
// window, tray and global shortcuts. The hybrid splits those responsibilities:
// the C++ shell owns the window layer, this process owns everything else, and
// it does so by importing the same modules Electron used, unmodified.
//
// That is the entire argument for the sidecar. control-plane, pty-run-manager,
// permission-server and openclaw/runtime are ~2,700 lines of ConPTY handling,
// local socket serving and CLI stream parsing that already work. Rewriting them
// in C++ would be weeks of effort for no user-visible gain.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'

import { IPC } from '../src/shared/types'
import { getShortcuts } from '../src/shared/shortcuts'
import { ControlPlane } from '../src/main/claude/control-plane'
import { getCliRuntime, getAgentDataHomes, cliInvocation } from '../src/main/openclaw/runtime'
import { getCliEnv } from '../src/main/cli-env'

const log = (...a: unknown[]) => console.error('[sidecar]', ...a)

type Req = { id?: number; channel: string; args?: any }

// stdout carries the protocol and nothing else; a stray console.log here would
// corrupt the stream, which is why log() goes to stderr.
function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function emit(event: string, payload?: unknown) {
  send({ event, payload })
}

// ─── Static server ───
//
// WebView2 refuses to load subresources over file://, so the renderer bundle,
// its CSS and the clui shim all fail silently when the page is opened as a
// file. Serving over loopback avoids that entirely and costs one Node server.
// Bound to 127.0.0.1 so nothing is reachable off-machine.
const WEB_PORT = Number(process.env.CLUI_WEB_PORT ?? 17817)
const WEB_ROOT = process.env.CLUI_WEB_ROOT ?? process.cwd()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function startWebServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)

      // Contain every request inside WEB_ROOT.
      const full = normalize(join(WEB_ROOT, rel))
      if (!full.startsWith(normalize(WEB_ROOT) + sep)) {
        res.writeHead(403).end('forbidden')
        return
      }

      const body = await readFile(full)
      res.writeHead(200, { 'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  return new Promise<void>((resolve) => {
    server.listen(WEB_PORT, '127.0.0.1', () => {
      log(`serving ${WEB_ROOT} on http://127.0.0.1:${WEB_PORT}`)
      resolve()
    })
  })
}

// ─── Backend ───

const INTERACTIVE_PTY = process.env.CLUI_INTERACTIVE_PERMISSIONS_PTY !== '0'
const controlPlane = new ControlPlane(INTERACTIVE_PTY)

// ControlPlane is an EventEmitter. These three forwards replace the broadcast()
// calls at src/main/index.ts:597-607 and carry the CLI event stream.
controlPlane.on('event', (tabId: string, event: unknown) => {
  emit('clui:normalized-event', { tabId, event })
})
controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  emit('clui:tab-status-change', { tabId, newStatus, oldStatus })
})
controlPlane.on('error', (tabId: string, error: unknown) => {
  emit('clui:enriched-error', { tabId, error })
})

/** Synchronous CLI call, as runCliSync did in the Electron main process. */
function runCli(args: string[], timeoutMs = 5000) {
  const { command, args: full } = cliInvocation(args)
  try {
    const stdout = String(
      execFileSync(command, full, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        env: getCliEnv(getCliRuntime().extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).trim()
    return { ok: true, stdout }
  } catch (err: any) {
    return { ok: false, stdout: String(err?.stdout ?? '').trim() }
  }
}

// ─── Channel table ───
//
// Keyed by the same IPC constants the renderer already uses, so the page-side
// shim needs no name translation. Anything absent fails loudly rather than
// resolving to undefined — an unwired channel should be obvious, not silent.

const handlers: Record<string, (args: any) => unknown | Promise<unknown>> = {
  // ── Boot path ──
  [IPC.START]: () => {
    const runtime = getCliRuntime()

    let version = 'unknown'
    const short = runCli(['-v'])
    if (short.ok && short.stdout) version = short.stdout
    else {
      const long = runCli(['--version'])
      if (long.ok && long.stdout) version = long.stdout
    }

    let auth: { email?: string } = {}
    let authSupported = true
    const probe = runCli(['auth', 'status'])
    if (probe.ok) {
      try {
        auth = JSON.parse(probe.stdout)
      } catch {
        // non-JSON output just means no email to show
      }
    } else {
      authSupported = false
    }

    return {
      cliCommand: runtime.kind,
      version,
      homePath: homedir(),
      email: auth.email ?? null,
      authSupported,
      agentDataHomes: getAgentDataHomes(),
    }
  },

  [IPC.CREATE_TAB]: () => ({ tabId: controlPlane.createTab() }),
  [IPC.GET_SHORTCUTS]: () => ({ platform: process.platform, shortcuts: getShortcuts(process.platform) }),

  // ── Prompts, PTY and the CLI event stream: the reason this process exists ──
  [IPC.PROMPT]: async ({ tabId, requestId, options }: any) => {
    if (!tabId) throw new Error('No tabId provided — prompt rejected')
    if (!requestId) throw new Error('No requestId provided — prompt rejected')
    await controlPlane.submitPrompt(tabId, requestId, options)
    return { accepted: true }
  },

  [IPC.CANCEL]: ({ requestId }: any) => controlPlane.cancel(requestId),
  [IPC.RETRY]: ({ tabId, requestId, options }: any) => controlPlane.retry(tabId, requestId, options),
  [IPC.STOP_TAB]: ({ tabId }: any) => controlPlane.cancelTab(tabId),
  [IPC.CLOSE_TAB]: ({ tabId }: any) => { controlPlane.closeTab(tabId); return true },
  [IPC.INIT_SESSION]: ({ tabId }: any) => { controlPlane.initSession(tabId); return true },
  [IPC.RESET_TAB_SESSION]: ({ tabId }: any) => { controlPlane.resetTabSession(tabId); return true },
  [IPC.SET_PERMISSION_MODE]: ({ mode }: any) => { controlPlane.setPermissionMode(mode); return true },
  [IPC.RESPOND_PERMISSION]: ({ tabId, questionId, optionId }: any) =>
    controlPlane.respondToPermission(tabId, questionId, optionId),
  [IPC.STATUS]: () => controlPlane.getHealth(),
  [IPC.TAB_HEALTH]: ({ tabId }: any) => controlPlane.getTabStatus(tabId) ?? null,
  [IPC.GET_CONNECTION_TARGET]: () => controlPlane.getConnectionTarget(),
  [IPC.SET_CONNECTION_TARGET]: ({ mode }: any) => {
    controlPlane.setConnectionTarget({ mode })
    return { ok: true }
  },

  ping: () => 'pong',

  /** Introspection so the UI can show exactly how much of the surface is live. */
  'sidecar:channels': () => {
    const all = Object.values(IPC) as string[]
    const wired = Object.keys(handlers).filter((k) => all.includes(k))
    return { wired: wired.sort(), wiredCount: wired.length, total: all.length }
  },
}

// ─── Dispatch ───

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let req: Req
    try {
      req = JSON.parse(trimmed)
    } catch {
      log('unparseable line:', trimmed.slice(0, 120))
      return
    }

    const handler = handlers[req.channel]
    if (!handler) {
      send({ id: req.id, ok: false, error: `not implemented in sidecar: ${req.channel}` })
      return
    }

    try {
      send({ id: req.id, ok: true, result: await handler(req.args ?? {}) })
    } catch (err: any) {
      send({ id: req.id, ok: false, error: String(err?.message ?? err) })
    }
  })
  .on('close', () => {
    log('stdin closed, shutting down')
    try {
      controlPlane.shutdown()
    } catch {
      // best effort on the way out
    }
    process.exit(0)
  })

await startWebServer()

{
  const all = Object.values(IPC) as string[]
  const wired = Object.keys(handlers).filter((k) => all.includes(k)).length
  log(`ready on node ${process.version}; ${wired}/${all.length} channels wired`)
  // The shell waits for this before navigating, so the server is guaranteed up.
  emit('sidecar:ready', { nodeVersion: process.version, wired, total: all.length, webPort: WEB_PORT })
}
