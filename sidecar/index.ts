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
import { appendFileSync, readFileSync as readFileSyncNode } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { writeFile, readdir, readFile as readFileAsync, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

import { IPC } from '../src/shared/types'
import type { GatewayConfigView, NodeHostStatus } from '../src/shared/types'
import { getShortcuts } from '../src/shared/shortcuts'
import { ControlPlane } from '../src/main/claude/control-plane'
import { getCliRuntime, getAgentDataHomes, cliInvocation } from '../src/main/openclaw/runtime'
import { getCliEnv } from '../src/main/cli-env'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from '../src/main/marketplace/catalog'

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

/** Read ~/.openclaw/openclaw.json. Never throws; a missing file is just {}. */
function readOpenclawConfig(): OpenclawConfig {
  try {
    return JSON.parse(readFileSyncNode(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8'))
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
function readWindowsUserEnv(name: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim() || null
  } catch {
    return null
  }
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
    if (process.env[name]) return process.env[name] as string
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

/** Async CLI call. The sync variant would block the whole sidecar for 45s. */
function runCliAsync(args: string[], timeoutMs = 20000, extraEnv: NodeJS.ProcessEnv = {}) {
  const { command, args: full } = cliInvocation(args)
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(
      command,
      full,
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        env: getCliEnv({ ...getCliRuntime().extraEnv, ...extraEnv }),
        maxBuffer: 8 * 1024 * 1024,
      },
      (err: any, stdout: string, stderr: string) =>
        resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || err?.message || '').trim() }),
    )
  })
}


/** True when the CLI is configured to route runs at a remote gateway. */
function isRemoteGatewayMode(): boolean {
  return readOpenclawConfig().gateway?.mode === 'remote'
}

/** Call a gateway RPC method and parse its JSON reply. Null on any failure. */
async function gatewayCallJson(method: string, params: unknown = {}, timeoutMs = 25000): Promise<any | null> {
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
    if (value) gatewayModelCache = { at: Date.now(), value }
    return value
  } finally {
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

  // The theme drives every colour in the UI. App.tsx swallows a getTheme
  // rejection with .catch(() => {}), so a missing channel here does not throw —
  // it just renders the whole launcher with no palette, which looks exactly
  // like the app failing to mount. Dark is the shell's default background.
  [IPC.GET_THEME]: () => ({ isDark: true }),

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
  [IPC.TAB_HEALTH]: ({ tabId }: any) => controlPlane.getTabStatus(tabId) ?? null,
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

  [IPC.OPENCLAW_SET_MODEL]: ({ model }: any) => {
    const r = runCli(['config', 'set', 'model', String(model)], 15000)
    // The cached list carries the current selection, so it is stale the moment
    // the model changes.
    invalidateGatewayModelCache()
    return r
  },
  [IPC.OPENCLAW_ONBOARD]: () => runCli(['onboard'], 60000),
  [IPC.OPENCLAW_RUN]: ({ args }: any) => runCli(Array.isArray(args) ? args.map(String) : [], 60000),
  // Returns NodeHostStatus (src/shared/types.ts:250) by parsing the CLI's
  // human-readable output. Returning raw stdout left the panel showing
  // "Not installed" while the node was registered and running.
  [IPC.NODE_STATUS]: (): NodeHostStatus => {
    const r = runCli(['node', 'status'], 20000)
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
  },
  [IPC.NODE_ACTION]: ({ action }: any) => runCli(['node', String(action)], 30000),
  [IPC.GATEWAY_STATUS]: async () => {
    const token = resolveGatewayToken()
    const res = await runCliAsync(['gateway', 'status'], 30000, token ? { OPENCLAW_GATEWAY_TOKEN: token } : {})
    const text = `${res.stdout}\n${res.stderr}`.trim()
    return {
      ok: res.ok,
      running: /Runtime:\s*running/i.test(text),
      installed: !/Service unit not found|Service not installed/i.test(text),
      output: redactSecrets(text),
    }
  },
  // The probe must carry the credential or the gateway answers unreachable —
  // which is exactly what the Control Center was reporting.
  [IPC.GATEWAY_PROBE]: async () => {
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
  },
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
      configPath: join(homedir(), '.openclaw', 'openclaw.json'),
    }
  },

  [IPC.TRANSCRIBE_AUDIO]: ({ audioBase64 }: any) => {
    // The CLI reads the clip from a file; a base64 blob on argv would blow the
    // command-line length limit.
    const file = join(tmpdir(), `clui-audio-${Date.now()}.webm`)
    try {
      require('node:fs').writeFileSync(file, Buffer.from(String(audioBase64), 'base64'))
      const r = runCli(['transcribe', file], 60000)
      return { error: r.ok ? null : 'transcription failed', transcript: r.ok ? r.stdout : null }
    } catch (err: any) {
      return { error: String(err?.message ?? err), transcript: null }
    }
  },

  // ── Sessions: read the CLI's own session directories ──
  [IPC.LIST_SESSIONS]: async () => {
    const out: unknown[] = []
    for (const home of getAgentDataHomes()) {
      const root = join(home, 'projects')
      try {
        for (const dir of await readdir(root)) {
          const full = join(root, dir)
          try {
            out.push({ project: dir, path: full, mtime: (await stat(full)).mtimeMs })
          } catch {
            // unreadable entry, skip
          }
        }
      } catch {
        // no projects dir under this home
      }
    }
    return out
  },
  [IPC.LOAD_SESSION]: async ({ sessionId, projectPath }: any) => {
    try {
      return { ok: true, content: await readFileAsync(join(String(projectPath), `${sessionId}.jsonl`), 'utf-8') }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  },

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
  emit('sidecar:ready', { nodeVersion: process.version, wired, total: all.length, webPort: WEB_PORT })  // single object arg, now safe
}
