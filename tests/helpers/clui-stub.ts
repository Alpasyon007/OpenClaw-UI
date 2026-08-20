import { vi } from 'vitest'
import { declaredApiMethods, implementedApiMethods } from './contract'

/**
 * A `window.clui` test double generated from the contract itself.
 *
 * Two properties matter:
 *
 *  1. Every method the contract declares exists, so components render.
 *  2. Reaching for a method the contract does *not* declare throws instead of
 *     returning `undefined`. In the real app that mistake shows up as a silent
 *     no-op — a button that does nothing — which is precisely the failure this
 *     harness exists to catch.
 */

type AnyFn = (...args: unknown[]) => unknown

export interface CluiStub {
  calls: Array<{ method: string; args: unknown[] }>
  /** Push an event to every listener registered through `on<Name>`. */
  emit(method: string, ...args: unknown[]): void
  /** Number of listeners currently registered for a subscription method. */
  listenerCount(method: string): number
  /** Queue the value a request-response method resolves with. */
  resolve(method: string, value: unknown): void
}

const DEFAULTS: Record<string, unknown> = {
  start: {
    version: '0.0.0-test',
    auth: {},
    mcpServers: [],
    projectPath: '/test/project',
    homePath: '/test/home',
    cliBinary: 'openclaw',
    cliCommand: 'openclaw',
    authSupported: true,
    mcpSupported: true,
  },
  createTab: { tabId: 'tab-test-1' },
  status: { tabs: [] },
  tabHealth: { tabs: [] },
  listSessions: [],
  loadSession: [],
  // Default to "no gateway to speak of", so every existing test renders the
  // picker exactly as it did before gateway sessions existed.
  listGatewaySessions: {
    ok: false,
    available: false,
    sessions: [],
    reason: 'unsupported',
    error: null,
    fetchedAt: 0,
  },
  loadGatewaySession: {
    ok: true,
    sessionKey: '',
    messages: [],
    truncated: false,
    totalMessages: null,
    error: null,
  },
  fetchMarketplace: { plugins: [], error: null },
  listInstalledPlugins: [],
  getShortcuts: { platform: 'win32', shortcuts: [] },
  getTheme: { isDark: true },
  isVisible: true,
  getDiagnostics: {},
  getRuntimeMetrics: { cpuPercent: 0, memoryMb: 0, uptimeSec: 0, timestamp: 0 },
  nodeStatus: { installed: false, running: false },
  gatewayStatus: { ok: true, running: false, installed: false, output: '' },
  gatewayProbe: { ok: true, reachable: false, capability: null, missingOperatorScope: false, output: '' },
  gatewayConfigGet: { mode: 'local', remoteUrl: '', tokenEnvVar: '' },
  getConnectionTarget: 'local',
  openclawModelInfo: { ok: true, provider: null, model: null, providers: [] },
}

let stub: CluiStub | null = null

export function installCluiStub(): CluiStub {
  const listeners = new Map<string, Set<AnyFn>>()
  const overrides = new Map<string, unknown>()
  const calls: Array<{ method: string; args: unknown[] }> = []

  const implemented = new Map(implementedApiMethods().map((m) => [m.name, m]))
  const names = new Set([...declaredApiMethods(), ...implemented.keys()])

  const api: Record<string, unknown> = {}

  for (const name of names) {
    const transport = implemented.get(name)?.transport ?? (name.startsWith('on') ? 'subscribe' : 'invoke')

    if (transport === 'subscribe') {
      api[name] = vi.fn((cb: AnyFn) => {
        calls.push({ method: name, args: [] })
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(cb)
        return () => listeners.get(name)!.delete(cb)
      })
      continue
    }

    if (transport === 'send') {
      api[name] = vi.fn((...args: unknown[]) => {
        calls.push({ method: name, args })
      })
      continue
    }

    api[name] = vi.fn(async (...args: unknown[]) => {
      calls.push({ method: name, args })
      if (overrides.has(name)) return overrides.get(name)
      return name in DEFAULTS ? DEFAULTS[name] : null
    })
  }

  // Anything not on the contract is a bug in the caller, not a gap in the stub.
  const guarded = new Proxy(api, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol' || prop === 'then' || prop.startsWith('__')) return undefined
      throw new Error(
        `window.clui.${prop} is not declared in src/shared/clui-contract.ts — ` +
          'the renderer would call an undefined bridge method at runtime.',
      )
    },
  })

  ;(window as unknown as { clui: unknown }).clui = guarded

  stub = {
    calls,
    emit(method, ...args) {
      const set = listeners.get(method)
      if (!set) throw new Error(`no listener registered for ${method}`)
      for (const fn of set) fn(...args)
    },
    listenerCount(method) {
      return listeners.get(method)?.size ?? 0
    },
    resolve(method, value) {
      overrides.set(method, value)
    },
  }
  return stub
}

export function cluiStub(): CluiStub {
  if (!stub) throw new Error('installCluiStub() has not run — is the jsdom setup file loaded?')
  return stub
}

export function resetCluiStub(): void {
  stub = null
  delete (window as unknown as { clui?: unknown }).clui
}
