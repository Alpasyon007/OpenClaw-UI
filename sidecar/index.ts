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
import {
  appendFileSync,
  readFileSync as readFileSyncNode,
  renameSync as renameSyncNode,
  statSync as statSyncNode,
  writeFileSync as writeFileSyncNode,
} from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { writeFile, readFile as readFileAsync, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

import { IPC } from '../src/shared/types'
import type { GatewayConfigView, NodeHostStatus, GatewaySessionListResult } from '../src/shared/types'
import { getShortcuts } from '../src/shared/shortcuts'
import { ControlPlane } from '../src/main/claude/control-plane'
import { getCliRuntime } from '../src/main/openclaw/runtime'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from '../src/main/marketplace/catalog'
import { listSessions, readLocalTranscript } from '../src/main/sessions'
import { runCliAsync, runBinAsync, probe, peekProbe, invalidateProbe, flushProbeCache } from '../src/main/cli-probe'
import {
  readGatewaySessions,
  readGatewaySessionHistory,
  classifyGatewayFailure,
  NO_CREDENTIAL,
  GATEWAY_SESSIONS_PROBE_KEY,
  GATEWAY_SESSIONS_TTL_MS,
  GATEWAY_SESSIONS_FAILURE_TTL_MS,
} from '../src/main/gateway-sessions'
import type { GatewayRpcResult } from '../src/main/gateway-sessions'
import { ensureSkills } from '../src/main/skills/installer'

/** How long after boot before skill provisioning may hit the network. */
const SKILL_PROVISION_DELAY_MS = 10_000

const log = (...a: unknown[]) => console.error('[sidecar]', ...a)

type Req = { id?: number; channel: string; args?: any }

// stdout carries the protocol and nothing else; a stray console.log here would
// corrupt the stream, which is why log() goes to stderr.
function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// Events carry an explicit positional argument list.
//
// The shim used to infer arguments from a payload object's key order, which
// works for {tabId, event} by luck but shreds any handler taking a single
// object — onSkillStatus(status) received status.a, status.b, ... as separate
// arguments. That is what put tab ids and status strings into the transcript.
function emit(event: string, ...args: unknown[]) {
  send({ event, args })
}

// ─── Static server ───
//
// WebView2 refuses to load subresources over file://, so the renderer bundle,
// its CSS and the clui shim all fail silently when the page is opened as a
// file. Serving over loopback avoids that entirely and costs one Node server.
// Bound to 127.0.0.1 so nothing is reachable off-machine.
const WEB_PORT = Number(process.env.CLUI_WEB_PORT ?? 17817)
// The port actually bound. Usually WEB_PORT, but the listener falls back to an
// ephemeral one when that is taken, and the shell has to be told which.
let webPort = WEB_PORT
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

      // Diagnostic sink. The page beacons here instead of through saucer's
      // exposed functions, so it works even if the JS bridge is the thing
      // that is broken — which is exactly what needs ruling in or out.
      if (url.pathname === '/__log') {
        const line = url.searchParams.get('m') ?? ''
        log('[page]', line)
        try {
          appendFileSync(join(WEB_ROOT, 'page.log'), `${line}\n`)
        } catch {
          // diagnostics must never take the server down
        }
        res.writeHead(204).end()
        return
      }

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

  return new Promise<void>((resolve, reject) => {
    // Without this listener Node rethrows 'error' as an uncaught exception and
    // the sidecar dies before its ready handshake, leaving the shell waiting on
    // a window that never appears. EADDRINUSE is the common case: a stale
    // sidecar from a hard kill still holds the fixed port.
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(`port ${WEB_PORT} is busy — falling back to an ephemeral port`)
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port
          webPort = port
          log(`serving ${WEB_ROOT} on http://127.0.0.1:${port}`)
          resolve()
        })
        return
      }
      reject(err)
    })
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
const promptSeen = new Map<string, number>()
let eventCount = 0

controlPlane.on('event', (tabId: string, event: unknown) => {
  eventCount++
  const kind = (event as any)?.type ?? 'unknown'
  log(`EVENT #${eventCount} tab=${String(tabId).slice(0, 8)} type=${kind}`)
  emit('clui:normalized-event', tabId, event)
})
controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  emit('clui:tab-status-change', tabId, newStatus, oldStatus)
})
controlPlane.on('error', (tabId: string, error: unknown) => {
  emit('clui:enriched-error', tabId, error)
})

type OpenclawConfig = {
  gateway?: {
    mode?: string
    bind?: string
    remote?: { enabled?: boolean; url?: string; token?: { source?: string; provider?: string; id?: string } }
  }
}

/**
 * Read ~/.openclaw/openclaw.json. Never throws; a missing file is just {}.
 *
 * Memoised on mtime+size. isRemoteGatewayMode() and resolveGatewayToken() both
 * call this, and both sit on paths that run per gateway RPC and per status
 * poll — so the naive version re-read and re-parsed the file dozens of times a
 * minute. statSync is cheap next to a read plus a parse, and keying on mtime
 * means an edit by the CLI is still picked up on the next call.
 */
function openclawConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json')
}

/**
 * Write openclaw.json atomically.
 *
 * The CLI writes this file too, so a truncating whole-file rewrite can leave
 * it unparseable for both processes. Write to a sibling temp file and rename,
 * which is atomic within a volume.
 */
function writeOpenclawConfig(config: OpenclawConfig): void {
  const path = openclawConfigPath()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSyncNode(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  renameSyncNode(tmp, path)
  configCache = null
}

let configCache: { key: string; value: OpenclawConfig } | null = null
function readOpenclawConfig(): OpenclawConfig {
  const path = join(homedir(), '.openclaw', 'openclaw.json')
  try {
    const st = statSyncNode(path)
    const key = `${st.mtimeMs}:${st.size}`
    if (configCache && configCache.key === key) return configCache.value

    const value = JSON.parse(readFileSyncNode(path, 'utf-8')) as OpenclawConfig
    configCache = { key, value }
    return value
  } catch {
    return {}
  }
}

/**
 * Strip credential-shaped values out of CLI output before it crosses IPC.
 * `openclaw node status` echoes the service environment block, which includes
 * the gateway token in plaintext, and the renderer pipes raw into a <pre>.
 */
function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(
      /((?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*"?)([^\s"',}]+)/gi,
      '$1<redacted>',
    )
    .replace(/\b[a-f0-9]{64}\b/gi, '<redacted>')
}


/**
 * Read a variable from the persistent Windows user environment.
 *
 * A token set with setx after this process started is not in process.env, so
 * the registry is the only place to find it. This is why the probe could not
 * authenticate: the credential existed but was invisible to us.
 */
const winUserEnvCache = new Map<string, string | null>()
function readWindowsUserEnv(name: string): string | null {
  if (process.platform !== 'win32') return null
  // Memoised: resolveGatewayToken() runs on every gateway status, probe and
  // RPC, and this is a synchronous spawn that blocks the protocol stream.
  // A variable set with setx after we started is not going to appear mid-run.
  if (winUserEnvCache.has(name)) return winUserEnvCache.get(name) ?? null

  let value: string | null = null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    value = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim() || null
  } catch {
    // Not set, or reg.exe unavailable.
  }

  winUserEnvCache.set(name, value)
  return value
}

/**
 * Resolve the gateway credential, matching src/main/index.ts:1921.
 * Checks the configured id first, then the conventional names, in our own
 * environment and then the persistent one.
 */
function resolveGatewayToken(): string | null {
  const configuredId = readOpenclawConfig().gateway?.remote?.token?.id || null
  const names = [configuredId, 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_REMOTE_TOKEN'].filter(Boolean) as string[]

  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  for (const name of names) {
    const fromRegistry = readWindowsUserEnv(name)
    if (fromRegistry) {
      log(`resolved gateway credential from the persistent user environment (${name})`)
      return fromRegistry
    }
  }
  return null
}


/** True when the CLI is configured to route runs at a remote gateway. */
function isRemoteGatewayMode(): boolean {
  return readOpenclawConfig().gateway?.mode === 'remote'
}

/** Call a gateway RPC method and parse its JSON reply. Null on any failure. */
async function gatewayCallJson(method: string, params: unknown = {}, timeoutMs = 25000): Promise<any> {
  const token = resolveGatewayToken()
  if (!token) {
    log(`gateway call ${method} skipped — no credential resolvable in this process`)
    return null
  }
  const res = await runCliAsync(
    ['gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    timeoutMs,
    { OPENCLAW_GATEWAY_TOKEN: token },
  )
  if (!res.stdout) {
    log(`gateway call ${method} produced no output: ${res.stderr.slice(0, 200)}`)
    return null
  }
  try {
    const parsed = JSON.parse(res.stdout)
    if (parsed && parsed.ok === false) {
      log(`gateway call ${method} rejected: ${parsed.error?.message || 'unknown error'}`)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Call a gateway RPC, preserving the gateway's own error text.
 *
 * A sibling of {@link gatewayCallJson} rather than a replacement for it: that
 * one collapses every failure to `null`, which is fine for a model list but
 * loses the single distinction this needs — "this gateway has no sessions.list"
 * (hide the group) versus "this gateway is down" (say so).
 */
async function gatewayCallRaw(
  method: string,
  params: unknown = {},
  timeoutMs = 25000,
): Promise<GatewayRpcResult> {
  const token = resolveGatewayToken()
  if (!token) return { body: null, errorMessage: NO_CREDENTIAL }

  const res = await runCliAsync(
    ['gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    timeoutMs,
    { OPENCLAW_GATEWAY_TOKEN: token },
  )
  if (!res.stdout) {
    return { body: null, errorMessage: res.stderr.slice(0, 400) || 'no output from gateway call' }
  }
  // The CLI prints a banner before the JSON on some paths, so start at the
  // first brace rather than assuming all of stdout parses.
  const start = res.stdout.indexOf('{')
  if (start === -1) return { body: null, errorMessage: 'gateway call returned no JSON' }
  try {
    const parsed = JSON.parse(res.stdout.slice(start))
    // An unknown method answers ok:false at exit code 0, so the payload — not
    // the exit status — is what says whether this worked.
    if (parsed && parsed.ok === false) {
      return { body: null, errorMessage: String(parsed.error?.message || 'gateway rejected the call') }
    }
    return { body: parsed, errorMessage: null }
  } catch {
    return { body: null, errorMessage: 'gateway call returned malformed JSON' }
  }
}

/**
 * Whether asking the gateway for sessions could possibly work.
 *
 * Consulted before any spawn. A purely local install must never pay for a CLI
 * invocation — or render the group at all — to be told what its own config
 * already says.
 */
function gatewaySessionsEligible(): { eligible: boolean; errorMessage: string } {
  if (getCliRuntime().kind !== 'openclaw') {
    return { eligible: false, errorMessage: 'unknown method: not an openclaw runtime' }
  }
  const gateway = readOpenclawConfig().gateway
  if (gateway?.mode !== 'remote' || !gateway?.remote?.url) {
    return { eligible: false, errorMessage: 'unknown method: no remote gateway configured' }
  }
  if (!resolveGatewayToken()) return { eligible: false, errorMessage: NO_CREDENTIAL }
  return { eligible: true, errorMessage: '' }
}

/**
 * The gateway's session list, cached.
 *
 * Two TTLs, not one. A successful listing is good for a minute — sessions
 * change on the order of a conversation. A failure is only good for ten
 * seconds, so a burst of popover opens collapses onto one spawn while a
 * gateway that comes back is noticed promptly rather than pinned as dead for
 * the rest of the minute.
 *
 * `probe()` holds a single TTL, so the failure window is enforced here by
 * invalidating a stale failure before asking.
 */
async function listGatewaySessionsCached(): Promise<GatewaySessionListResult> {
  const cached = peekProbe<GatewaySessionListResult>(GATEWAY_SESSIONS_PROBE_KEY)
  if (cached && !cached.available && Date.now() - cached.fetchedAt >= GATEWAY_SESSIONS_FAILURE_TTL_MS) {
    invalidateProbe(GATEWAY_SESSIONS_PROBE_KEY)
  }
  return probe<GatewaySessionListResult>(
    GATEWAY_SESSIONS_PROBE_KEY,
    async () => {
      // Never spawn to learn what config already says.
      const gate = gatewaySessionsEligible()
      if (!gate.eligible) {
        const { reason, error } = classifyGatewayFailure(gate.errorMessage)
        return { ok: false, available: false, sessions: [], reason, error, fetchedAt: Date.now() }
      }
      const result = await readGatewaySessions(gatewayCallRaw, Date.now())
      // Re-stamp: the failure window must be measured from when the answer
      // landed, not from when the call was dialled. A 20s timeout would
      // otherwise consume the whole 10s TTL before the entry was even written,
      // so a failed listing was never cached at all and every reopen paid for
      // another full spawn.
      return { ...result, fetchedAt: Date.now() }
    },
    // Serve a known-good list instantly and refresh behind it; the next open
    // gets the fresher value. Never persisted — it names the user's sessions.
    { ttlMs: GATEWAY_SESSIONS_TTL_MS, staleWhileRevalidate: true },
  )
}

/**
 * Model list from the gateway.
 *
 * In remote mode the agent runs on the gateway, so its list is the one that
 * matters — local config generally has no models section at all. Reading local
 * config here is why the picker came up empty.
 */
async function _fetchGatewayModelInfoUncached() {
  const [modelsRes, agentsRes] = await Promise.all([
    gatewayCallJson('models.list'),
    gatewayCallJson('agents.list'),
  ])
  if (!modelsRes?.models) return null

  const byProvider = new Map<string, Array<{ id: string; name: string }>>()
  for (const m of modelsRes.models as Array<Record<string, any>>) {
    if (m.available !== true) continue
    const provider = String(m.provider || '').trim()
    const id = String(m.id || '').trim()
    if (!provider || !id) continue
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider)!.push({ id, name: String(m.name || id) })
  }

  // Current selection comes from the default agent's primary model.
  let provider: string | null = null
  let model: string | null = null
  const defaultId = agentsRes?.defaultId || 'main'
  const agent = (agentsRes?.agents || []).find((a: any) => a?.id === defaultId) || agentsRes?.agents?.[0]
  const primary = String(agent?.model?.primary || '')
  if (primary.includes('/')) {
    const idx = primary.indexOf('/')
    provider = primary.slice(0, idx) || null
    model = primary.slice(idx + 1) || null
    // A wildcard is a valid key in the per-model settings map but not a
    // concrete model id — treat it as nothing selected.
    if (model === '*' || model === '') model = null
  }

  return {
    ok: true,
    provider,
    model,
    providers: Array.from(byProvider.entries())
      .map(([id, models]) => ({ id, models: models.sort((a, b) => a.id.localeCompare(b.id)) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}


// The gateway round trip is ~9s, so an uncached picker leaves its dropdowns
// empty long enough to look broken — and a component that re-renders fires the
// call again. Cache the result and collapse concurrent callers onto one fetch.
const GATEWAY_MODEL_TTL_MS = 60_000
let gatewayModelCache: { at: number; value: Awaited<ReturnType<typeof _fetchGatewayModelInfoUncached>> } | null = null
let gatewayModelInflight: ReturnType<typeof _fetchGatewayModelInfoUncached> | null = null

function invalidateGatewayModelCache(): void {
  gatewayModelCache = null
}

async function fetchGatewayModelInfo(force = false) {
  if (!force && gatewayModelCache && Date.now() - gatewayModelCache.at < GATEWAY_MODEL_TTL_MS) {
    return gatewayModelCache.value
  }
  // A second caller arriving mid-fetch waits on the same promise rather than
  // starting another round trip.
  if (gatewayModelInflight) return gatewayModelInflight

  gatewayModelInflight = _fetchGatewayModelInfoUncached()
  try {
    const value = await gatewayModelInflight
    // Only cache a real answer: caching null would pin a transient failure for
    // a full minute.
    // Deliberate: the in-flight guard above means only one caller reaches
    // here per fetch, and the assignment is a whole new object.
    // eslint-disable-next-line require-atomic-updates
    if (value) gatewayModelCache = { at: Date.now(), value }
    return value
  } finally {
    // eslint-disable-next-line require-atomic-updates
    gatewayModelInflight = null
  }
}

/** Launch something through the OS, replacing Electron's shell module. */
function openWith(command: string, args: string[]) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    execFile(command, args, { windowsHide: true }, (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true }),
    )
  })
}

/**
 * Run the CLI.
 *
 * This was `execFileSync`, inherited from the Electron main process where it
 * was already wrong. In the sidecar it is worse: stdout carries the entire
 * protocol, so blocking the event loop blocks every channel at once — an
 * `onboard` call with its 60s budget froze the whole app, not just its own
 * request. Nothing here may spawn synchronously.
 *
 * runCliAsync also throttles: at most two CLI processes run at a time and each
 * is dropped below normal priority. A single `openclaw` invocation parses a
 * ~90MB module graph before doing any work, so an unbounded fan-out of them is
 * what made launching lag the whole machine.
 */
async function runCli(args: string[], timeoutMs = 20000) {
  const res = await runCliAsync(args, timeoutMs)
  return { ok: res.ok, stdout: res.stdout, stderr: res.stderr }
}

/** A command attempt: CLI subcommand args, or an unrelated external binary. */
type RunCandidate = { args: string[]; bin?: string }

/**
 * Named actions the Control Center and onboarding buttons invoke.
 *
 * The renderer sends an action name, never raw CLI arguments — deliberately,
 * because the arguments differ between CLI versions and the renderer must not
 * be in the business of constructing command lines. Several actions therefore
 * list more than one candidate and take the first that succeeds.
 *
 * This table was lost when the Electron main process was removed; the sidecar
 * handler that replaced it destructured `{ args }` and ran the bare CLI with an
 * empty argument list, so every button in the Control Center silently did
 * nothing (or printed the CLI's own help text).
 */
const OPENCLAW_ACTIONS: Record<string, RunCandidate[]> = {
  gateway_start: [{ args: ['gateway', 'start'] }],
  gateway_stop: [{ args: ['gateway', 'stop'] }],
  gateway_restart: [{ args: ['gateway', 'restart'] }],
  gateway_install: [{ args: ['gateway', 'install'] }],
  channels_status: [{ args: ['channels', 'status'] }],
  plugins_list: [{ args: ['plugins', 'list'] }],
  skills_list: [{ args: ['skills', 'list'] }],
  update_check: [
    { args: ['update', 'check'] },
    { args: ['update', 'status'] },
    { args: ['update'] },
  ],
  update_upgrade: [
    { args: ['update', 'upgrade'] },
    { args: ['update', 'install'] },
    { args: ['update'] },
  ],
  gateway_link_whatsapp_qr: [
    { args: ['channels', 'whatsapp', 'link'] },
    { args: ['channels', 'whatsapp', 'qr'] },
    { args: ['channels', 'link', 'whatsapp'] },
  ],
}

/** Slug rules for the parameterised `clawhub_*` actions. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i

function candidatesFor(action: string): RunCandidate[] | { error: string } {
  const fixed = OPENCLAW_ACTIONS[action]
  if (fixed) return fixed

  if (action.startsWith('clawhub_install:')) {
    const slug = action.slice('clawhub_install:'.length).trim()
    if (!SLUG_RE.test(slug)) return { error: `Invalid skill slug: ${slug}` }
    return [
      { bin: 'clawhub', args: ['install', slug] },
      { args: ['clawhub', 'install', slug] },
    ]
  }
  if (action.startsWith('clawhub_inspect:')) {
    const slug = action.slice('clawhub_inspect:'.length).trim()
    if (!SLUG_RE.test(slug)) return { error: `Invalid skill slug: ${slug}` }
    return [{ bin: 'clawhub', args: ['inspect', slug] }]
  }
  if (action.startsWith('clawhub_search:')) {
    const query = action.slice('clawhub_search:'.length).trim()
    if (!query) return { error: 'Search query is required' }
    return [{ bin: 'clawhub', args: ['search', query, '--limit', '8'] }]
  }

  return { error: `Unsupported action: ${action}` }
}

async function runOpenclawAction(action: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const resolved = candidatesFor(action)
  if (!Array.isArray(resolved)) return { ok: false, output: '', error: resolved.error }

  let lastError = 'Command failed'
  let lastStdout = ''
  const tried: string[] = []

  for (const candidate of resolved) {
    tried.push([candidate.bin ?? getCliRuntime().kind, ...candidate.args].join(' '))

    // External binaries run as-is; CLI subcommands go through the resolved
    // runtime so they work on Windows, where the CLI is a Node script.
    const res = candidate.bin
      ? await runBinAsync(candidate.bin, candidate.args, 15000)
      : await runCliAsync(candidate.args, 15000)

    if (res.ok) {
      // ClawHub exits 0 with nothing to say when it has no match; treat that as
      // a miss so the next candidate gets a turn.
      if (
        (action.startsWith('clawhub_search:') || action.startsWith('clawhub_inspect:')) &&
        res.stdout.length === 0
      ) {
        lastError = 'ClawHub returned no output'
        continue
      }
      return { ok: true, output: redactSecrets(res.stdout) }
    }

    lastError = res.stderr || 'Command failed'
    lastStdout = res.stdout
  }

  return {
    ok: false,
    output: redactSecrets(lastStdout),
    error: `${redactSecrets(lastError)}\nTried:\n${tried.join('\n')}`.trim(),
  }
}

// ─── Channel table ───
//
// Keyed by the same IPC constants the renderer already uses, so the page-side
// shim needs no name translation. Anything absent fails loudly rather than
// resolving to undefined — an unwired channel should be obvious, not silent.

// ─── Boot facts ───

/** The part of START that costs a CLI spawn to learn. */
type StartFacts = {
  version: string
  auth: { email?: string; subscriptionType?: string; authMethod?: string }
  mcpServers: string[]
  authSupported: boolean
  mcpSupported: boolean
}

const START_KEY = 'start-facts'
const UNKNOWN_START: StartFacts = {
  version: 'unknown',
  auth: {},
  mcpServers: [],
  authSupported: true,
  mcpSupported: true,
}

/** Version and auth are fixed for the lifetime of an install. */
const START_TTL_MS = 30 * 60_000
/** Node host service state changes only when the user acts on it. */
const NODE_STATUS_TTL_MS = 60_000
/** Local gateway service state. */
const GATEWAY_STATUS_TTL_MS = 60_000
/**
 * Gateway reachability. Short on purpose: this is reached by the "Test
 * Connection" button, and a button that says it is testing must actually test.
 * The window only collapses a burst of clicks onto one invocation.
 */
const GATEWAY_PROBE_TTL_MS = 5_000

/**
 * True when the CLI is telling us the subcommand does not exist.
 *
 * Worth matching precisely: a missing subcommand means "hide this part of the
 * UI", while a genuine failure means "show it, but report the error". The
 * pattern used to check only for "unknown command"/"did you mean", which this
 * CLI never says — it answers `OpenClaw does not know the command "auth"`, so
 * the auth row stayed visible and permanently blank on every install where the
 * subcommand is absent.
 */
function isUnknownCommand(res: { stdout: string; stderr: string }): boolean {
  return /unknown command|did you mean|does not know the command|is not a known command/i.test(
    `${res.stdout}\n${res.stderr}`,
  )
}

async function collectStartFacts(): Promise<StartFacts> {
  // Concurrent, not sequential. `-v` answers in ~90ms while `auth status` and
  // `mcp list` each load the CLI's whole module graph; running them in series
  // cost ~11s for nothing. The throttle caps how many actually overlap.
  const [short, authProbe, mcpProbe] = await Promise.all([
    runCli(['-v'], 15000),
    runCli(['auth', 'status'], 20000),
    runCli(['mcp', 'list'], 20000),
  ])

  let version = short.ok && short.stdout ? short.stdout : ''
  if (!version) {
    const long = await runCli(['--version'], 15000)
    if (long.ok && long.stdout) version = long.stdout
  }

  let auth: StartFacts['auth'] = {}
  const authSupported = !isUnknownCommand(authProbe)
  if (authProbe.ok && authSupported) {
    try {
      auth = JSON.parse(authProbe.stdout)
    } catch {
      // non-JSON output just means no email to show
    }
  }

  // `mcp list` reports "none configured" as a prose sentence on success, which
  // is not a server list. Only lines that look like entries count.
  const mcpSupported = !isUnknownCommand(mcpProbe)
  const mcpServers =
    mcpProbe.ok && mcpSupported && !/^No OpenClaw-managed MCP servers/i.test(mcpProbe.stdout)
      ? mcpProbe.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      : []

  return { version: version || 'unknown', auth, mcpServers, authSupported, mcpSupported }
}

/**
 * Shape this exactly as CluiAPI.start() declares it.
 *
 * The sidecar used to return a flat `email` and no projectPath, cliBinary or
 * mcp fields, while the renderer reads `result.auth?.email` and the rest — so
 * the account row and the CLI label were permanently blank. The contract is
 * the source of truth for this payload; anything it declares gets answered.
 */
function buildStartPayload(facts: StartFacts) {
  const runtime = getCliRuntime()
  return {
    version: facts.version,
    auth: facts.auth,
    mcpServers: facts.mcpServers,
    projectPath: process.cwd(),
    homePath: homedir(),
    cliBinary: runtime.label,
    cliCommand: runtime.kind,
    authSupported: facts.authSupported,
    mcpSupported: facts.mcpSupported,
  }
}

// ─── Node host + gateway readers ───
//
// Split out of the channel table so each can be handed to probe() as a plain
// producer, and so the cache key is the only thing deciding when they run.

async function readNodeStatus(): Promise<NodeHostStatus> {
  const r = await runCli(['node', 'status'], 20000)
  const text = r.stdout

  const grab = (re: RegExp) => text.match(re)?.[1]?.trim() ?? null
  const command = grab(/^Command:\s*(.+)$/m) ?? ''
  const runtime = grab(/^Runtime:\s*(.+)$/m) ?? ''

  return {
    installed: /registered/i.test(grab(/^Service:\s*(.+)$/m) ?? ''),
    running: /\brunning\b/i.test(runtime),
    pid: Number(runtime.match(/pid\s+(\d+)/i)?.[1]) || null,
    displayName: grab(/^Name:\s*(.+)$/m),
    nodeId: grab(/^Node ID:\s*(.+)$/m),
    gatewayHost: command.match(/--host\s+(\S+)/)?.[1] ?? null,
    gatewayPort: Number(command.match(/--port\s+(\d+)/)?.[1]) || null,
    tls: /--tls\b/.test(command),
    serviceKind: grab(/^Service:\s*(.+)$/m),
    // The type requires credentials stripped before this crosses IPC.
    raw: redactSecrets(text),
  }
}

async function readGatewayStatus() {
  const token = resolveGatewayToken()
  const res = await runCliAsync(['gateway', 'status'], 30000, token ? { OPENCLAW_GATEWAY_TOKEN: token } : {})
  const text = `${res.stdout}\n${res.stderr}`.trim()
  return {
    ok: res.ok,
    running: /Runtime:\s*running/i.test(text),
    installed: !/Service unit not found|Service not installed/i.test(text),
    output: redactSecrets(text),
  }
}

// The probe must carry the credential or the gateway answers unreachable —
// which is exactly what the Control Center was reporting.
async function readGatewayProbe() {
  const token = resolveGatewayToken()
  const res = await runCliAsync(['gateway', 'probe'], 45000, token ? { OPENCLAW_GATEWAY_TOKEN: token } : {})
  const text = `${res.stdout}\n${res.stderr}`.trim()
  return {
    ok: res.ok,
    reachable: /Reachable:\s*yes/i.test(text),
    capability: text.match(/Capability:\s*([^\n·]+)/i)?.[1]?.trim() || null,
    // The gateway rejects operator calls until the credential carries
    // operator scope; surface that rather than a generic failure.
    missingOperatorScope: /missing scope:\s*operator/i.test(text),
    output: redactSecrets(text),
  }
}

const handlers: Record<string, (args: any) => unknown> = {
  // ── Boot path ──
  //
  // Answers from cache so the first frame is not waiting on the CLI. A
  // first-ever launch gets placeholders and a second payload over START_INFO
  // once the probes land; every later launch reads the persisted values.
  [IPC.START]: async () => {
    const cached = peekProbe<StartFacts>(START_KEY)

    if (!cached) {
      void probe(START_KEY, collectStartFacts, { ttlMs: START_TTL_MS, persist: true })
        .then((facts) => emit(IPC.START_INFO, buildStartPayload(facts)))
        .catch((err) => log('START probe failed:', err?.message))
      return buildStartPayload(UNKNOWN_START)
    }

    return buildStartPayload(
      await probe(START_KEY, collectStartFacts, {
        ttlMs: START_TTL_MS,
        persist: true,
        staleWhileRevalidate: true,
        onRefresh: (value) => emit(IPC.START_INFO, buildStartPayload(value as StartFacts)),
      }),
    )
  },

  [IPC.CREATE_TAB]: () => ({ tabId: controlPlane.createTab() }),

  // The theme drives every colour in the UI. App.tsx swallows a getTheme
  // rejection with .catch(() => {}), so a missing channel here does not throw —
  // it just renders the whole launcher with no palette, which looks exactly
  // like the app failing to mount. Dark is the shell's default background.
  // GET_THEME is deliberately absent. It used to answer a hardcoded
  // `isDark: true`, which is why the app ignored the user's light/dark setting
  // entirely. Node cannot read it — there is no registry API — so the shell
  // owns both halves now: the shim routes clui.getTheme at an exposed
  // get_dark_mode, and clui:theme-changed is pushed from the Win32 message
  // loop when the OS broadcasts a colour change.

  // Cheap, self-contained channels the UI touches early. Each returns the same
  // shape the Electron handler did; none of them need a window.
  [IPC.IS_VISIBLE]: () => true,
  [IPC.GET_DIAGNOSTICS]: () => ({ platform: process.platform, node: process.version }),
  [IPC.GET_RUNTIME_METRICS]: () => ({ cpu: 0, memory: process.memoryUsage().rss }),
  [IPC.GET_SHORTCUTS]: () => ({ platform: process.platform, shortcuts: getShortcuts(process.platform) }),

  // ── Prompts, PTY and the CLI event stream: the reason this process exists ──
  [IPC.PROMPT]: async ({ tabId, requestId, options }: any) => {
    // Duplicate submissions show up as a duplicated transcript and as the CLI
    // reporting the session file changed underneath it, so make them visible.
    promptSeen.set(requestId, (promptSeen.get(requestId) ?? 0) + 1)
    log(`PROMPT tab=${String(tabId).slice(0, 8)} req=${String(requestId).slice(0, 8)} submission#${promptSeen.get(requestId)}`)
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
  // `tabHealth()` takes no argument, so this used to destructure `tabId` out of
  // an empty object and answer `getTabStatus(undefined) ?? null`. The renderer's
  // reconciliation loop reads `health.tabs`, found `null`, and returned early
  // every 1.5s — tabs stuck on "running" after the CLI died were never unstuck.
  [IPC.TAB_HEALTH]: () => controlPlane.getHealth(),
  [IPC.GET_CONNECTION_TARGET]: () => controlPlane.getConnectionTarget(),
  [IPC.SET_CONNECTION_TARGET]: (target: any) => {
    // Ported from src/main/index.ts:2286-2328. The previous one-liner passed
    // only `mode` and dropped url/token/viaConfig, so a gateway target was
    // never actually configured — the app could not see a running node.
    if (target?.mode !== 'gateway' || !target?.url) {
      controlPlane.setConnectionTarget({ mode: target?.mode })
      return { ok: true }
    }

    const config = readOpenclawConfig()
    const tokenEnvVar = config.gateway?.remote?.token?.id || null
    const envToken = (tokenEnvVar && process.env[tokenEnvVar]) || undefined

    // Preferred path: openclaw.json already names this gateway and its
    // credential resolves, so the run needs no flags and the token stays out
    // of the process table. gateway.mode must be 'remote' — it is the only key
    // the CLI consults when deciding to route remotely.
    if (config.gateway?.mode === 'remote' && config.gateway?.remote?.url === target.url && envToken) {
      controlPlane.setConnectionTarget({ mode: 'gateway', url: target.url, viaConfig: true })
      return { ok: true }
    }

    // Fallback: pass the credential explicitly. The CLI rejects --url without
    // one, at the cost of argv exposure.
    const token = target.token || envToken
    if (!token && !target.password) {
      return {
        ok: false,
        error:
          'No gateway credential available — set the token environment variable referenced by gateway.remote.token',
      }
    }
    log('connection target set with an explicit credential; config does not describe this gateway')
    controlPlane.setConnectionTarget({ ...target, token })
    return { ok: true }
  },

  // ── Gateway sessions ──
  //
  // `openclaw sessions list` cannot answer this: under gateway.mode=remote it
  // still reports the LOCAL store. Only `gateway call` crosses the wire.
  //
  // Cached, because the picker opens often and one round trip is seconds. The
  // renderer never waits on this to draw its local list.
  [IPC.LIST_GATEWAY_SESSIONS]: () => listGatewaySessionsCached(),
  [IPC.LOAD_GATEWAY_SESSION]: ({ sessionKey }: any) =>
    readGatewaySessionHistory(gatewayCallRaw, String(sessionKey ?? '')),

  // ── Window-layer channels ──
  //
  // The first four were already no-ops in the Electron main process: the native
  // window is fixed-size and every expand/collapse happens inside the renderer.
  // Kept so the surface is complete rather than erroring.
  [IPC.RESIZE_HEIGHT]: () => true,
  [IPC.SET_WINDOW_WIDTH]: () => true,
  [IPC.ANIMATE_HEIGHT]: () => true,
  [IPC.DRAG_HOLDING]: () => true,
  // SET_IGNORE_MOUSE_EVENTS, HIDE_WINDOW, WINDOW_READY and WINDOW_DISMISS_READY
  // are intercepted by the shim and handled by the shell, which owns the window.
  [IPC.TRACE_SHELL]: () => true,
  [IPC.SET_BRANDING]: () => true,

  // ── Marketplace: the real catalog module, now Electron-free ──
  [IPC.MARKETPLACE_FETCH]: ({ forceRefresh }: any) => fetchCatalog(forceRefresh),
  [IPC.MARKETPLACE_INSTALLED]: () => listInstalled(),
  // Both take positional arguments, not the renderer's payload object. Passing
  // the object straight through made every install fail its own input
  // validation with an unhelpful message.
  [IPC.MARKETPLACE_INSTALL]: ({ repo, pluginName, marketplace, sourcePath, isSkillMd }: any) =>
    installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd),
  [IPC.MARKETPLACE_UNINSTALL]: ({ pluginName }: any) => uninstallPlugin(pluginName),

  // ── CLI-backed channels ──
  [IPC.OPENCLAW_HEALTH]: () => runCli(['doctor'], 20000),
  [IPC.OPENCLAW_MODEL_INFO]: async () => {
    if (isRemoteGatewayMode()) {
      const remote = await fetchGatewayModelInfo()
      if (remote) return remote

      log('gateway model info unavailable — falling back to local config')
      if (!resolveGatewayToken()) {
        const id = readOpenclawConfig().gateway?.remote?.token?.id || 'OPENCLAW_REMOTE_TOKEN'
        return {
          ok: false,
          provider: null,
          model: null,
          providers: [],
          error: `Gateway credential not readable by this app. Set ${id} for your user account, then restart OpenClaw UI.`,
        }
      }
    }

    // Local mode, or remote with a resolvable credential but no gateway answer.
    const config: any = readOpenclawConfig()
    const providersMap = config.models?.providers || {}
    const providers = Object.entries(providersMap).map(([id, info]: [string, any]) => ({
      id,
      models: (info.models || [])
        .map((m: any) => ({ id: String(m.id || '').trim(), name: String(m.name || m.id || '').trim() }))
        .filter((m: any) => m.id),
    }))

    const primary = config.agents?.defaults?.model?.primary || ''
    let provider: string | null = null
    let model: string | null = null
    if (primary.includes('/')) {
      const idx = primary.indexOf('/')
      provider = primary.slice(0, idx) || null
      model = primary.slice(idx + 1) || null
      if (model === '*' || model === '') model = null
    }
    return { ok: true, provider, model, providers }
  },

  [IPC.OPENCLAW_SET_MODEL]: async ({ model }: any) => {
    const r = await runCli(['config', 'set', 'model', String(model)], 15000)
    // The cached list carries the current selection, so it is stale the moment
    // the model changes.
    invalidateGatewayModelCache()
    return r
  },
  [IPC.OPENCLAW_ONBOARD]: () => runCli(['onboard'], 60000),
  [IPC.OPENCLAW_RUN]: ({ action }: any) => runOpenclawAction(String(action ?? '')),

  // Returns NodeHostStatus (src/shared/types.ts) by parsing the CLI's
  // human-readable output. Returning raw stdout left the panel showing
  // "Not installed" while the node was registered and running.
  //
  // Cached: the call is ~7s of CLI startup and the panel polls it so an
  // external change is eventually noticed, not because a Windows service
  // changes on a UI cadence. Stale answers go out immediately and the refresh
  // arrives over NODE_STATUS_UPDATE.
  [IPC.NODE_STATUS]: () =>
    probe('node-status', readNodeStatus, {
      ttlMs: NODE_STATUS_TTL_MS,
      staleWhileRevalidate: true,
      onRefresh: (value) => emit(IPC.NODE_STATUS_UPDATE, value),
    }),

  [IPC.NODE_ACTION]: async ({ action }: any) => {
    const r = await runCli(['node', String(action)], 30000)
    // The action changes exactly what the cached status describes.
    invalidateProbe('node-status')
    return r
  },

  [IPC.GATEWAY_STATUS]: () =>
    probe('gateway-status', readGatewayStatus, {
      ttlMs: GATEWAY_STATUS_TTL_MS,
      staleWhileRevalidate: true,
    }),

  [IPC.GATEWAY_PROBE]: () => probe('gateway-probe', readGatewayProbe, { ttlMs: GATEWAY_PROBE_TTL_MS }),

  // Returns GatewayConfigView (src/shared/types.ts:269). Field names matter:
  // the panel reads remoteUrl/tokenRef/tokenResolvable, and my earlier ad-hoc
  // shape left the URL and Token rows blank while mode rendered fine.
  [IPC.GATEWAY_CONFIG_GET]: (): GatewayConfigView => {
    const config = readOpenclawConfig()
    const ref = config.gateway?.remote?.token
    const envId = ref?.id || 'OPENCLAW_REMOTE_TOKEN'
    return {
      mode: (config.gateway?.mode as 'local' | 'remote') ?? null,
      remoteUrl: config.gateway?.remote?.url ?? null,
      // Descriptor only — the token value never crosses IPC.
      tokenRef: ref ? { source: ref.source ?? 'env', id: envId } : null,
      tokenResolvable: !!process.env[envId],
      configPath: openclawConfigPath(),
    }
  },

  /**
   * Write the gateway settings the Control Center's Connection card edits.
   *
   * The port never wired this, so switching between Auto/Local/Remote failed
   * with "not implemented in sidecar" and the mode never persisted.
   */
  [IPC.GATEWAY_CONFIG_SET]: ({ mode, remoteUrl, tokenEnvVar }: any) => {
    try {
      const config = readOpenclawConfig()
      if (!config.gateway) config.gateway = {}

      if (mode) config.gateway.mode = mode

      if (remoteUrl !== undefined) {
        const url = String(remoteUrl).trim()
        if (url) {
          const parsed = (() => {
            try {
              return new URL(url)
            } catch {
              return null
            }
          })()
          if (!parsed) return { ok: false, error: `Not a valid URL: ${url}` }
          // Refuse plaintext WebSocket to a non-loopback host: the credential
          // would cross the public internet unencrypted.
          const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
          if (parsed.protocol === 'ws:' && !isLoopback) {
            return { ok: false, error: 'Refusing an insecure ws:// URL for a remote host — use wss://' }
          }
          if (!['ws:', 'wss:'].includes(parsed.protocol)) {
            return { ok: false, error: `Gateway URL must be ws:// or wss:// (got ${parsed.protocol})` }
          }
          if (!config.gateway.remote) config.gateway.remote = {}
          config.gateway.remote.url = url
          config.gateway.remote.enabled = true
        }
      }

      if (tokenEnvVar) {
        if (!/^[A-Z][A-Z0-9_]*$/i.test(String(tokenEnvVar))) {
          return { ok: false, error: `Not a valid environment variable name: ${tokenEnvVar}` }
        }
        if (!config.gateway.remote) config.gateway.remote = {}
        config.gateway.remote.token = { source: 'env', provider: 'default', id: String(tokenEnvVar) }
      }

      writeOpenclawConfig(config)
      // Everything cached about the gateway described the old endpoint.
      invalidateProbe('gateway-probe')
      invalidateProbe('gateway-status')
      invalidateProbe(GATEWAY_SESSIONS_PROBE_KEY)
      invalidateGatewayModelCache()
      log(`gateway config updated: mode=${config.gateway.mode} url=${config.gateway.remote?.url || '(unset)'}`)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update gateway config' }
    }
  },

  [IPC.TRANSCRIBE_AUDIO]: async ({ audioBase64 }: any) => {
    // The CLI reads the clip from a file; a base64 blob on argv would blow the
    // command-line length limit.
    const file = join(tmpdir(), `clui-audio-${Date.now()}.webm`)
    try {
      await writeFile(file, Buffer.from(String(audioBase64), 'base64'))
      const r = await runCli(['transcribe', file], 60000)
      return { error: r.ok ? null : 'transcription failed', transcript: r.ok ? r.stdout : null }
    } catch (err: any) {
      return { error: String(err?.message ?? err), transcript: null }
    }
  },

  // ── Sessions: read the CLI's own session directories ──
  // Returns SessionMeta[] (src/shared/types.ts). The port had this listing the
  // project *directories* instead — objects with no sessionId — which the
  // history picker then dereferenced, throwing and unmounting the whole app.
  [IPC.LIST_SESSIONS]: ({ projectPath }: any) =>
    listSessions(projectPath == null ? undefined : String(projectPath)),
  // Answers SessionLoadMessage[], which is what the contract has always
  // declared. This used to read `<projectPath>/<id>.jsonl` — a path transcripts
  // never live at — and answer `{ ok, content }`, so every resume opened empty.
  [IPC.LOAD_SESSION]: ({ sessionId, projectPath }: any) =>
    readLocalTranscript(String(sessionId ?? ''), projectPath == null ? undefined : String(projectPath)),

  // ── Files ──
  [IPC.PASTE_IMAGE]: async ({ dataUrl }: any) => {
    const match = String(dataUrl).match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null
    const [, mimeType, ext, b64] = match
    const file = join(tmpdir(), `clui-paste-${Date.now()}.${ext}`)
    const buf = Buffer.from(b64, 'base64')
    await writeFile(file, buf)
    return { id: randomUUID(), type: 'image', name: `pasted.${ext}`, path: file, mimeType, dataUrl, size: buf.length }
  },
  [IPC.EXPORT_CONVERSATION]: async ({ content, suggestedName }: any) => {
    // No native save dialog in the sidecar, so write beside the CLI's data and
    // hand back the path for the UI to reveal.
    const file = join(homedir(), 'Downloads', String(suggestedName ?? `conversation-${Date.now()}.md`))
    try {
      await writeFile(file, String(content), 'utf-8')
      return { ok: true, path: file }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  },

  // ── Shell open: no Electron shell module, but Windows ships equivalents ──
  [IPC.OPEN_EXTERNAL]: ({ url }: any) => openWith('rundll32', ['url.dll,FileProtocolHandler', String(url)]),
  [IPC.OPEN_PATH]: ({ path: target }: any) => openWith('explorer', [String(target)]),
  [IPC.OPEN_IN_TERMINAL]: ({ projectPath }: any) =>
    openWith(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '', 'cmd', '/k', `cd /d "${String(projectPath)}"`]),

  // ── Support for the native-UI channels ──
  //
  // C++ owns the dialogs and the capture; it hands back plain paths. Turning
  // those into the attachment objects the renderer expects is file work, so it
  // belongs here rather than in C++.
  'clui:describe-files': async ({ paths }: any) => {
    const out: unknown[] = []
    for (const path of (Array.isArray(paths) ? paths : []).map(String)) {
      try {
        const info = await stat(path)
        const ext = (path.split('.').pop() ?? '').toLowerCase()
        const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)
        const mimeType = image ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'
        out.push({
          id: randomUUID(),
          type: image ? 'image' : 'file',
          name: path.split(/[\/]/).pop(),
          path,
          mimeType,
          size: info.size,
          // Only images need a preview, and only small ones are worth inlining.
          dataUrl:
            image && info.size < 8 * 1024 * 1024
              ? `data:${mimeType};base64,${(await readFileAsync(path)).toString('base64')}`
              : undefined,
        })
      } catch {
        // unreadable path: skip rather than fail the whole batch
      }
    }
    return out
  },

  'clui:write-text-file': async ({ path, content }: any) => {
    try {
      await writeFile(String(path), String(content), 'utf-8')
      return { ok: true, path: String(path) }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  },

  'clui:read-text-file': async ({ path }: any) => {
    try {
      return { ok: true, content: await readFileAsync(String(path), 'utf-8') }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  },

  ping: () => 'pong',

  /** Introspection so the UI can show exactly how much of the surface is live. */
  'sidecar:channels': () => {
    const all = Object.values(IPC) as string[]
    const wired = Object.keys(handlers).filter((k) => all.includes(k))
    return { wired: wired.sort(), wiredCount: wired.length, total: all.length }
  },
}


/**
 * Channels whose preload payload is a bare value rather than an object.
 *
 * `initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId)` puts a
 * plain string on the wire, so a handler destructuring `{ tabId }` from it gets
 * undefined. PROMPT worked only because its payload happens to be an object,
 * which is why prompts submitted but the session was never initialised and the
 * run produced no events at all.
 *
 * Normalising here keeps every handler written against a named field.
 */
const BARE_ARG: Record<string, string> = {
  [IPC.CANCEL]: 'requestId',
  [IPC.STOP_TAB]: 'tabId',
  [IPC.CLOSE_TAB]: 'tabId',
  [IPC.TAB_HEALTH]: 'tabId',
  [IPC.INIT_SESSION]: 'tabId',
  [IPC.RESET_TAB_SESSION]: 'tabId',
  [IPC.SET_PERMISSION_MODE]: 'mode',
  [IPC.OPEN_EXTERNAL]: 'url',
  [IPC.OPEN_PATH]: 'path',
  [IPC.PASTE_IMAGE]: 'dataUrl',
  [IPC.TRANSCRIBE_AUDIO]: 'audioBase64',
  [IPC.LIST_SESSIONS]: 'projectPath',
  [IPC.RESIZE_HEIGHT]: 'height',
  [IPC.SET_WINDOW_WIDTH]: 'width',
  [IPC.DRAG_HOLDING]: 'holding',
  [IPC.TRACE_SHELL]: 'line',
  [IPC.SET_BRANDING]: 'branding',
}

/** Give every handler an object, whatever shape arrived on the wire. */
function normalizeArgs(channel: string, args: unknown): any {
  if (args !== null && typeof args === 'object') return args
  const key = BARE_ARG[channel]
  if (key) return { [key]: args }
  // SET_CONNECTION_TARGET and friends already send an object; anything else
  // bare and unmapped is passed through so the handler can decide.
  return args ?? {}
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
      send({ id: req.id, ok: true, result: await handler(normalizeArgs(req.channel, req.args)) })
    } catch (err: any) {
      send({ id: req.id, ok: false, error: String(err?.message ?? err) })
    }
  })
  .on('close', () => {
    log('stdin closed, shutting down')
    try {
      // Persist what we learned about the CLI so the next launch paints from
      // it instead of re-probing.
      flushProbeCache()
    } catch {
      // best effort on the way out
    }
    try {
      controlPlane.shutdown()
    } catch {
      // best effort on the way out
    }
    process.exit(0)
  })

// Wrapped rather than top-level await: the bundle is CJS so that require()
// works for node-pty, and CJS has no top-level await.
void (async () => {
  await startWebServer()
})()

{
  const all = Object.values(IPC) as string[]
  const wired = Object.keys(handlers).filter((k) => all.includes(k)).length
  log(`ready on node ${process.version}; ${wired}/${all.length} channels wired`)
  // The shell waits for this before navigating, so the server is guaranteed up.
  emit('sidecar:ready', { nodeVersion: process.version, wired, total: all.length, webPort })  // single object arg, now safe
}

// ─── Skill provisioning ───
//
// The Electron main process ran this on startup; the port dropped it, so the
// manifest's skills were never installed and clui:skill-status never fired.
//
// Deferred, because it downloads a tarball: doing it during boot puts a
// network round trip against the first paint, and nothing in the UI is waiting
// on the result. Failures are reported to the renderer and logged, never
// thrown — a skill that will not install must not take the app down with it.
setTimeout(() => {
  void ensureSkills((status) => {
    log(`skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    emit(IPC.SKILL_STATUS, status)
  }).catch((err) => log('skill provisioning failed:', err?.message ?? err))
}, SKILL_PROVISION_DELAY_MS)
