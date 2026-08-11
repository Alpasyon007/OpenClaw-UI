import { execFile } from 'child_process'
import { constants as osConstants, homedir, setPriority } from 'os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { cliInvocation, getCliRuntime } from './openclaw/runtime'
import { getCliEnv } from './cli-env'
import { log as _log } from './logger'

function log(msg: string): void {
  _log('probe', msg)
}

export interface CliResult {
  ok: boolean
  stdout: string
  stderr: string
}

// ─── Spawn throttle ───

/**
 * How many CLI probes may run at once.
 *
 * Every invocation is a fresh Node process that parses the CLI's ~90MB module
 * graph before it does any work — measured at 4-7s for `auth status`,
 * `mcp list`, `node status` and `gateway call`. Launch used to fire six of
 * these at once (two gateway RPCs, three from the START handler, one update
 * check), which saturates the machine and is what made the whole desktop
 * stutter while the launcher appeared.
 *
 * Two keeps a multi-probe refresh moving without ever handing the CLI more
 * than a small slice of the CPU.
 */
const MAX_CONCURRENT_PROBES = 2

let activeProbes = 0
const waiting: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (activeProbes < MAX_CONCURRENT_PROBES) {
    activeProbes++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      activeProbes++
      resolve()
    })
  })
}

function releaseSlot(): void {
  activeProbes--
  const next = waiting.shift()
  if (next) next()
}

/**
 * Drop a spawned probe below the UI's scheduling priority.
 *
 * These are background status checks; none of them should ever compete with
 * the compositor or with an actual agent run for a core. Best-effort — the
 * call needs no privileges for a child of this process, but a race with a
 * fast-exiting child throws ESRCH.
 */
function deprioritize(pid: number | undefined): void {
  if (!pid) return
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Child already exited, or the platform refused — not worth reporting.
  }
}

function execThrottled(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return acquireSlot().then(
    () =>
      new Promise<CliResult>((resolve) => {
        const startedAt = Date.now()
        const child = execFile(
          command,
          args,
          { encoding: 'utf-8', timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 },
          (err: any, stdout: string, stderr: string) => {
            releaseSlot()
            const elapsed = Date.now() - startedAt
            if (elapsed > 3000) log(`slow probe (${elapsed}ms): ${args.slice(0, 3).join(' ')}`)
            resolve({
              ok: !err,
              stdout: String(stdout || '').trim(),
              stderr: String(stderr || err?.message || '').trim(),
            })
          },
        )
        deprioritize(child.pid)
      }),
  )
}

/**
 * Run the CLI without blocking the main thread.
 *
 * The synchronous variant freezes the entire Electron main process for the
 * duration — measured at ~4s for `auth status` and ~7s for `mcp list` — which
 * stalls IPC, PTY event forwarding, and rendering. Nothing may use a
 * synchronous spawn for CLI work.
 */
export function runCliAsync(
  args: string[],
  timeoutMs = 20000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const { command, args: full } = cliInvocation(args)
  return execThrottled(command, full, timeoutMs, getCliEnv({ ...getCliRuntime().extraEnv, ...extraEnv }))
}

/** Async runner for a binary that is not the resolved CLI (e.g. clawhub). */
export function runBinAsync(bin: string, args: string[], timeoutMs = 15000): Promise<CliResult> {
  return execThrottled(bin, args, timeoutMs, getCliEnv())
}

// ─── Probe cache ───

interface CacheEntry<T> {
  at: number
  value: T
}

const memory = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/** Keys whose last value survives a restart, so relaunch paints immediately. */
const persistedKeys = new Set<string>()
let diskLoaded = false
let diskDirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Per-user application data directory.
 *
 * Stands in for what Electron's `app.getPath('userData')` returned. The
 * sidecar is a plain Node process with no Electron to ask, so resolve the
 * platform convention directly rather than dropping another dotfile in the
 * home directory.
 */
function appDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'openclaw-ui')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'openclaw-ui')
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'openclaw-ui')
}

function cacheFile(): string {
  return join(appDataDir(), 'probe-cache.json')
}

function loadDisk(): void {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const path = cacheFile()
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, CacheEntry<unknown>>
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.at === 'number' && !memory.has(key)) memory.set(key, entry)
    }
  } catch {
    // Corrupt or unreadable cache is not an error — we just probe fresh.
  }
}

function scheduleFlush(): void {
  diskDirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushProbeCache()
  }, 1000)
}

/** Persist the restart-surviving entries. Safe to call at any time. */
export function flushProbeCache(): void {
  if (!diskDirty) return
  diskDirty = false
  try {
    const out: Record<string, CacheEntry<unknown>> = {}
    for (const key of persistedKeys) {
      const entry = memory.get(key)
      if (entry) out[key] = entry
    }
    const path = cacheFile()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(out), 'utf-8')
    renameSync(tmp, path)
  } catch (err: any) {
    log(`probe cache flush failed: ${err?.message}`)
  }
}

export interface ProbeOptions {
  /** How long a value is considered fresh. */
  ttlMs: number
  /**
   * Serve an expired value immediately and refresh behind it, instead of
   * making the caller wait. Only ever blocks when nothing is cached at all.
   */
  staleWhileRevalidate?: boolean
  /** Keep the last value across restarts. Never use for secrets. */
  persist?: boolean
  /** Called when a background refresh produces a new value. */
  onRefresh?: (value: unknown) => void
}

function refresh<T>(key: string, fn: () => Promise<T>, opts: ProbeOptions): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing

  const run = fn()
    .then((value) => {
      memory.set(key, { at: Date.now(), value })
      if (opts.persist) {
        persistedKeys.add(key)
        scheduleFlush()
      }
      return value
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, run)
  return run
}

/**
 * Cache a CLI probe by key, collapsing concurrent callers onto one spawn.
 *
 * Every status check in this app used to shell out unconditionally, so the
 * Control Center's poll loops re-paid 4-7s of process startup on a fixed
 * cadence for values that change on the order of minutes. Going through here
 * means a repeat check is free until its TTL expires, and simultaneous callers
 * (poll loop + a button + a warm-up) share a single invocation.
 */
export async function probe<T>(key: string, fn: () => Promise<T>, opts: ProbeOptions): Promise<T> {
  loadDisk()

  const entry = memory.get(key) as CacheEntry<T> | undefined
  const age = entry ? Date.now() - entry.at : Infinity

  if (entry && age < opts.ttlMs) return entry.value

  if (entry && opts.staleWhileRevalidate) {
    // Serve stale now; let the refresh land through onRefresh.
    //
    // Only the caller that actually starts the refresh reports it. Attaching
    // onRefresh unconditionally would hang one callback per concurrent stale
    // reader onto the same deduped promise, so a poll loop and a button
    // pressed together broadcast the identical result twice.
    if (!inflight.has(key)) {
      void refresh(key, fn, opts)
        .then((value) => opts.onRefresh?.(value))
        .catch(() => {})
    }
    return entry.value
  }

  return refresh(key, fn, opts)
}

/** Last known value regardless of age, or null when nothing was ever cached. */
export function peekProbe<T>(key: string): T | null {
  loadDisk()
  const entry = memory.get(key) as CacheEntry<T> | undefined
  return entry ? entry.value : null
}

/** Drop a cached value so the next {@link probe} call re-runs it. */
export function invalidateProbe(key: string): void {
  memory.delete(key)
  if (persistedKeys.has(key)) scheduleFlush()
}
