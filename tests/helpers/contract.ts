import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A second, independent reader of the bridge's source files.
 *
 * `sidecar/gen-shim.mjs` already parses `clui-contract.ts` to *write* the shim.
 * This module parses the same files to *check* them. Deliberately not shared
 * code: if gen-shim's regexes silently stop matching a method, a shared parser
 * would go blind in exactly the same way and the tests would still pass. Two
 * implementations disagreeing is the signal.
 */

export const REPO_ROOT = join(__dirname, '..', '..')

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

export const SOURCES = {
  contract: () => read('src/shared/clui-contract.ts'),
  types: () => read('src/shared/types.ts'),
  sidecar: () => read('sidecar/index.ts'),
  shim: () => read('shell/web/clui-shim.js'),
  genShim: () => read('sidecar/gen-shim.mjs'),
}

export type Transport = 'invoke' | 'send' | 'subscribe'

export interface ContractMethod {
  name: string
  transport: Transport
  /** The `IPC.FOO` constant name, or null when the channel is a string literal. */
  constName: string | null
  /** The resolved wire string, e.g. `clui:cancel`. */
  channel: string
  /** Declared parameter names, types stripped. */
  params: string[]
  /** The raw payload expression, verbatim from the source. */
  payload: string
}

/** `IPC` constant name -> wire string, read from `src/shared/types.ts`. */
export function ipcChannels(): Map<string, string> {
  const src = SOURCES.types()
  const block = /export const IPC\s*=\s*\{([\s\S]*?)\n\}\s*as const/.exec(src)
  if (!block) throw new Error('could not locate the IPC const in src/shared/types.ts')

  const map = new Map<string, string>()
  for (const m of block[1].matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)) {
    map.set(m[1], m[2])
  }
  if (map.size === 0) throw new Error('parsed the IPC const but found no entries')
  return map
}

/** Method names declared on the `CluiAPI` interface (the renderer's view). */
export function declaredApiMethods(): string[] {
  return [...declaredSignatures().keys()]
}

/**
 * Method name -> the raw parameter list as declared on the interface, so a
 * caller can tell `cancel(requestId: string)` from `gatewayConfigSet(patch: {…})`.
 */
export function declaredSignatures(): Map<string, string> {
  const src = SOURCES.contract()
  const block = /export interface CluiAPI \{([\s\S]*?)\n\}/.exec(src)
  if (!block) throw new Error('could not locate the CluiAPI interface')

  const out = new Map<string, string>()
  const body = block[1]
  // Signatures may wrap across lines (gatewayProbe, openclawModelInfo), so walk
  // the body tracking bracket depth rather than matching line by line.
  const re = /^ {2}([a-zA-Z_][\w]*)\(/gm
  for (const m of body.matchAll(re)) {
    const open = m.index + m[0].length
    let depth = 1
    let i = open
    while (i < body.length && depth > 0) {
      const ch = body[i]
      if ('({['.includes(ch)) depth++
      else if (')}]'.includes(ch)) depth--
      if (depth === 0) break
      i++
    }
    out.set(m[1], body.slice(open, i))
  }
  if (out.size === 0) throw new Error('parsed the CluiAPI interface but found no methods')
  return out
}

/**
 * True when a method's single declared parameter is a primitive.
 *
 * This is what makes the bare-payload check trustworthy: `exportConversation`
 * and `gatewayConfigSet` both forward a lone identifier, but that identifier is
 * an object literal at runtime, so `normalizeArgs` passes it straight through
 * and destructuring works. Only a primitive genuinely needs wrapping.
 */
export function forwardsPrimitive(method: string): boolean {
  const params = declaredSignatures().get(method)
  if (params === undefined) return false
  const first = splitTopLevel(params)[0]
  if (!first) return false
  const colon = first.indexOf(':')
  if (colon < 0) return false
  const type = first.slice(colon + 1).trim()
  return /^(string|number|boolean)(\s*\|\s*null)?$/.test(type)
}

/** Split a parameter or argument list on commas that are not nested. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if ('({[<'.includes(ch)) depth++
    else if (')}]>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * Methods the generated shim reassigns by hand after emitting the table.
 *
 * These call into saucer directly instead of forwarding to the sidecar, so the
 * sidecar legitimately has no handler for their channel. Derived from the shim
 * rather than hardcoded, so moving a method between the two never needs a test
 * edit — and never silently escapes the checks either.
 */
export function shimOverrides(): Set<string> {
  const names = new Set<string>()
  for (const m of SOURCES.shim().matchAll(/^\s*window\.clui\.([a-zA-Z_][\w]*)\s*=/gm)) {
    if (m[1] !== '__meta') names.add(m[1])
  }
  return names
}

/** Entries of the `api` object literal — what actually reaches the shim. */
export function implementedApiMethods(): ContractMethod[] {
  const src = SOURCES.contract()
  const channels = ipcChannels()
  const out: ContractMethod[] = []

  const shapes: Array<[Transport, RegExp]> = [
    ['invoke', /^\s{2}([a-zA-Z_][\w]*):\s*\(([^)]*)\)\s*=>\s*invoke\(\s*(?:IPC\.([A-Z0-9_]+)|'([^']+)')\s*(?:,\s*([\s\S]*?))?\)\s*,?\s*$/gm],
    ['send', /^\s{2}([a-zA-Z_][\w]*):\s*\(([^)]*)\)\s*=>\s*send\(\s*(?:IPC\.([A-Z0-9_]+)|'([^']+)')\s*(?:,\s*([\s\S]*?))?\)\s*,?\s*$/gm],
    ['subscribe', /^\s{2}([a-zA-Z_][\w]*):\s*\(([^)]*)\)\s*=>\s*subscribe\(\s*(?:IPC\.([A-Z0-9_]+)|'([^']+)')\s*(?:,\s*([\s\S]*?))?\)\s*,?\s*$/gm],
  ]

  for (const [transport, re] of shapes) {
    for (const m of src.matchAll(re)) {
      const [, name, params, constName, literal, payload] = m
      const channel = constName ? channels.get(constName) : literal
      if (!channel) throw new Error(`${name}: no IPC constant named ${constName}`)
      out.push({
        name,
        transport,
        constName: constName ?? null,
        channel,
        params: params
          .split(',')
          .map((p) => p.replace(/[?:].*$/, '').trim())
          .filter(Boolean),
        payload: (payload ?? '').trim(),
      })
    }
  }
  return out
}

export interface SidecarHandler {
  /** The `IPC.FOO` constant name used as the computed key. */
  constName: string
  channel: string
  /** Property names destructured out of the single `args` parameter. */
  destructured: string[]
  /** True when the handler takes no parameter at all. */
  ignoresArgs: boolean
}

/** Keys of the sidecar's `handlers` record, with their argument shape. */
export function sidecarHandlers(): SidecarHandler[] {
  const src = SOURCES.sidecar()
  const channels = ipcChannels()
  const start = src.indexOf('const handlers:')
  if (start < 0) throw new Error('could not locate the handlers record in sidecar/index.ts')

  const out: SidecarHandler[] = []
  const re = /^\s{2}\[IPC\.([A-Z0-9_]+)\]:\s*(?:async\s*)?\(([^)]*)\)/gm
  re.lastIndex = start
  for (const m of src.slice(start).matchAll(/^\s{2}\[IPC\.([A-Z0-9_]+)\]:\s*(?:async\s*)?\(([^)]*)\)/gm)) {
    const [, constName, params] = m
    const channel = channels.get(constName)
    if (!channel) throw new Error(`handler references unknown IPC constant ${constName}`)

    const destructured: string[] = []
    const obj = /\{([^}]*)\}/.exec(params)
    if (obj) {
      for (const part of obj[1].split(',')) {
        const key = part.split(':')[0].split('=')[0].trim()
        if (key) destructured.push(key)
      }
    }
    out.push({
      constName,
      channel,
      destructured,
      ignoresArgs: params.trim() === '',
    })
  }
  if (out.length === 0) throw new Error('parsed the handlers record but found no entries')
  return out
}

/** The sidecar's bare-argument adapter: channel constant -> property name. */
export function bareArgMap(): Map<string, string> {
  const src = SOURCES.sidecar()
  const block = /const BARE_ARG:\s*Record<string, string>\s*=\s*\{([\s\S]*?)\n\}/.exec(src)
  if (!block) throw new Error('could not locate the BARE_ARG map in sidecar/index.ts')

  const map = new Map<string, string>()
  for (const m of block[1].matchAll(/\[IPC\.([A-Z0-9_]+)\]:\s*'([^']+)'/g)) {
    map.set(m[1], m[2])
  }
  return map
}

/** Method names the generated shim actually exposes on `window.clui`. */
export function shimMethods(): string[] {
  const src = SOURCES.shim()
  const names = new Set<string>()
  for (const m of src.matchAll(/^\s{4}([a-zA-Z_][\w]*):\s*function\s*\(/gm)) {
    names.add(m[1])
  }
  return [...names]
}

/**
 * A payload is "bare" when it forwards a plain identifier rather than building
 * an object — `invoke(IPC.CANCEL, requestId)` as opposed to
 * `invoke(IPC.PROMPT, { tabId, requestId, options })`. Bare payloads arrive at
 * the sidecar as a primitive and only survive destructuring if `normalizeArgs`
 * knows to wrap them.
 */
export function isBarePayload(payload: string): boolean {
  if (!payload) return false
  return /^[a-zA-Z_][\w.]*$/.test(payload)
}

/**
 * Keys of an object-literal payload, or null when the payload is not a literal.
 *
 * `invoke(IPC.PROMPT, { tabId, requestId, options })` yields
 * `['tabId','requestId','options']`. Handles both shorthand and `key: value`
 * form, which is all the contract uses.
 */
export function payloadKeys(payload: string): string[] | null {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const inner = trimmed.slice(1, -1)
  return splitTopLevel(inner)
    .map((part) => part.split(':')[0].trim())
    .filter((k) => /^[a-zA-Z_][\w]*$/.test(k))
}
