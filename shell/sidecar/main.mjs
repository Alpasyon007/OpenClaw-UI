// Node sidecar for the saucer shell.
//
// The point of this process is that the expensive, fiddly half of the app does
// not have to be rewritten in C++. node-pty with its bundled ConPTY binaries,
// the permission-hook HTTP server, CLI spawning and stream parsing — roughly
// 2,700 of the 7,610 backend lines — keep running on Node exactly as they do
// under Electron. The C++ shell owns only the window and the webview.
//
// Protocol: newline-delimited JSON, both directions, over stdin/stdout.
//   in   { id, channel, args }        request
//   out  { id, ok, result }           reply
//   out  { id, ok: false, error }     failure
//   out  { event, payload }           unsolicited push (no id)
//
// stdout is reserved for the protocol. Anything diagnostic goes to stderr, or
// it would corrupt the stream.

import { createInterface } from 'node:readline'
import { homedir, platform, release } from 'node:os'
import process from 'node:process'

const log = (...a) => console.error('[sidecar]', ...a)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/** Push an event with no request behind it — the CLI event stream needs this. */
function emit(event, payload) {
  send({ event, payload })
}

// ─── Handlers ───
//
// Stand-ins with the same shape as the real IPC surface: one cheap synchronous
// call, one async call, and one that streams. Those three shapes cover all 57
// channels in src/main/index.ts.

const handlers = {
  ping: () => 'pong',

  getStaticInfo: () => ({
    nodeVersion: process.version,
    platform: platform(),
    release: release(),
    homePath: homedir(),
    pid: process.pid,
  }),

  // Async request/response, the shape most of the 46 ipcMain.handle channels use.
  async slowEcho({ text, delayMs = 200 }) {
    await new Promise((r) => setTimeout(r, delayMs))
    return `echo: ${text}`
  },

  // Streaming. This is the shape that matters most: under Electron the CLI's
  // stdout is parsed and forwarded to the renderer as a stream of events, and a
  // request/response bridge alone could not carry it.
  async runDemo({ steps = 4 }) {
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 150))
      emit('demo:progress', { step: i, of: steps })
    }
    emit('demo:done', { steps })
    return { started: true, steps }
  },
}

// ─── Dispatch ───

const rl = createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let req
  try {
    req = JSON.parse(trimmed)
  } catch (err) {
    log('unparseable line:', trimmed.slice(0, 120))
    return
  }

  const { id, channel, args } = req
  const handler = handlers[channel]

  if (!handler) {
    send({ id, ok: false, error: `no such channel: ${channel}` })
    return
  }

  try {
    send({ id, ok: true, result: await handler(args ?? {}) })
  } catch (err) {
    send({ id, ok: false, error: String(err?.message ?? err) })
  }
})

rl.on('close', () => {
  log('stdin closed, exiting')
  process.exit(0)
})

log(`ready on node ${process.version}, ${Object.keys(handlers).length} channels`)
emit('sidecar:ready', { nodeVersion: process.version })
