/**
 * Control Center data — health, status, nodes and configuration.
 *
 * Split by scope rather than by screen, because the two halves fail
 * differently. `health` and `status` need only `operator.read` and work on any
 * paired device; `node.status` and `config.*` need `operator.admin`, which a
 * companion device is deliberately not granted by default.
 *
 * That distinction is the whole design of this module: a device without admin
 * still gets a useful Control Center — it just gets the read-only half, with
 * one clear line about what the other half needs, rather than four spinners
 * that never resolve.
 */
import { create } from 'zustand'
import {
  HealthResultSchema,
  M,
  NodeListResultSchema,
  explainCapability,
  satisfiesScope,
  type GatewayNode,
} from '@openclaw/protocol'
import { currentCapabilities, tracked, useApp } from './store'

export interface AdminState {
  health: Record<string, unknown> | null
  status: Record<string, unknown> | null
  nodes: GatewayNode[]
  config: Record<string, unknown> | null

  loading: boolean
  /** Set when the whole admin half is unavailable, with the reason. */
  adminBlocked: string | null
  /** Per-section failures that are not a scope problem. */
  errors: Record<string, string>

  refresh: () => Promise<void>
  hasAdmin: () => boolean
}

export const useAdmin = create<AdminState>((set, get) => ({
  health: null,
  status: null,
  nodes: [],
  config: null,
  loading: false,
  adminBlocked: null,
  errors: {},

  hasAdmin: () => satisfiesScope(useApp.getState().scopes, 'operator.admin'),

  /**
   * Fetch everything this device is entitled to.
   *
   * Each section is settled independently — one gateway that has no
   * `node.status` must not blank the health panel next to it. Failures land in
   * `errors` keyed by section so the UI can annotate exactly the card that
   * failed.
   */
  async refresh() {
    if (useApp.getState().conn !== 'ready') {
      set({ adminBlocked: 'Not connected to a gateway.' })
      return
    }

    set({ loading: true, errors: {} })
    const admin = get().hasAdmin()

    const readable: Array<[string, Promise<unknown>]> = [
      ['health', tracked<unknown>(M.HEALTH, {})],
      ['status', tracked<unknown>(M.STATUS, {})],
      ['nodes', tracked<unknown>(M.NODE_LIST, {})],
    ]

    // Only attempted with the scope. Calling without it produces a pre-flight
    // rejection that would be cached as "forbidden" and then reported as though
    // the gateway had refused, which sends the user looking in the wrong place.
    const privileged: Array<[string, Promise<unknown>]> = admin
      ? [['config', tracked<unknown>(M.CONFIG_GET, {})]]
      : []

    const results = await Promise.allSettled([
      ...readable.map(([, p]) => p),
      ...privileged.map(([, p]) => p),
    ])
    const keys = [...readable.map(([k]) => k), ...privileged.map(([k]) => k)]

    const errors: Record<string, string> = {}
    const next: Partial<AdminState> = {}

    results.forEach((result, index) => {
      const key = keys[index]
      if (result.status === 'rejected') {
        errors[key] = describe(result.reason)
        return
      }
      switch (key) {
        case 'health': {
          const parsed = HealthResultSchema.safeParse(result.value)
          next.health = parsed.success ? parsed.data : null
          return
        }
        case 'status': {
          const parsed = HealthResultSchema.safeParse(result.value)
          next.status = parsed.success ? parsed.data : null
          return
        }
        case 'nodes': {
          const parsed = NodeListResultSchema.safeParse(result.value)
          next.nodes = parsed.success ? parsed.data.nodes : []
          return
        }
        case 'config': {
          next.config = isRecord(result.value) ? result.value : null
          return
        }
      }
    })

    set({
      ...next,
      errors,
      loading: false,
      adminBlocked: admin
        ? explainCapability(currentCapabilities().get(M.CONFIG_GET), 'gateway configuration')
        : 'This device is paired without the operator.admin scope, so gateway configuration and node control are hidden. Turn admin on in Settings and re-approve the device on the gateway.',
    })
  },
}))

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Flatten a nested payload into label/value rows.
 *
 * `health` and `status` are deliberately unmodelled — the gateway adds counters
 * freely and a fixed schema would render a shrinking subset of the truth as the
 * server gains fields. Flattening shows all of it, and keeps working when the
 * shape changes.
 *
 * Depth is capped rather than recursed without limit: a payload containing a
 * cycle would otherwise hang the render, and nothing four levels deep in a
 * status blob is readable on a phone anyway.
 */
export function flattenPayload(
  value: unknown,
  prefix = '',
  depth = 0,
): Array<{ label: string; value: string }> {
  if (depth > 3 || value == null) return []

  if (Array.isArray(value)) {
    // Arrays of scalars read far better as one line than as N rows named [0].
    if (value.every((v) => typeof v !== 'object' || v === null)) {
      return [{ label: prefix || 'items', value: value.map(String).join(', ') || '(empty)' }]
    }
    return value.flatMap((item, index) => flattenPayload(item, `${prefix}[${index}]`, depth + 1))
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenPayload(child, prefix ? `${prefix}.${key}` : key, depth + 1),
    )
  }

  return [{ label: prefix || 'value', value: formatScalar(value) }]
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return String(value)
}

/** A node's display name, from whichever field carried one. */
export function nodeLabel(node: GatewayNode): string {
  return node.name ?? node.host ?? node.nodeId ?? node.id ?? 'node'
}

/** Whether a node counts as up, from whichever field the gateway reported. */
export function nodeOnline(node: GatewayNode): boolean {
  if (typeof node.online === 'boolean') return node.online
  const status = (node.status ?? '').toLowerCase()
  return status === 'online' || status === 'ready' || status === 'connected'
}
