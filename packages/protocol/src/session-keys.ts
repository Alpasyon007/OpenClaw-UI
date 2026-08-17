/**
 * Naming helpers for gateway session keys.
 *
 * **Currently duplicated** from `src/shared/session-keys.ts`, which the desktop
 * renderer still imports. Deduplicating means deleting that file and rewriting
 * its importers, and those are in-flight uncommitted work — so the copy stays
 * until the shared-package extraction (M2) does the move properly. The logic
 * here is a faithful copy; if one changes and the other does not, this comment
 * is where the bug will have come from.
 */

/**
 * The human-facing tail of a gateway session key.
 *
 * A key is `agent:<agentId>:<name>`, where the name may itself contain colons.
 * Only the `agent:<id>:` prefix is stripped — nothing else is interpreted.
 *
 *   'agent:main:main'                 -> 'main'
 *   'agent:main:clui-a7105ce4-…'      -> 'clui-a7105ce4-…'
 *   'agent:main:cron:99801675-…'      -> 'cron:99801675-…'
 *   'no-colons-here'                  -> 'no-colons-here'
 *
 * Never throws and never returns an empty string for a non-empty input.
 */
export function deriveGatewayLabel(sessionKey: string): string {
  const key = String(sessionKey ?? '')
  const parts = key.split(':')
  const tail = parts.length >= 3 ? parts.slice(2).join(':') : key
  return tail || key
}

/** True for keys the desktop app generates for its own tabs (`clui-<tabId>`). */
export function isCluiSessionKey(sessionKey: string): boolean {
  return deriveGatewayLabel(sessionKey).startsWith('clui-')
}

/**
 * What to show for a gateway session.
 *
 * The gateway supplies a `displayName` for sessions created through its own
 * surfaces ('Cron: daily-morning-briefing') but not for ones the desktop opens,
 * so the key is the fallback rather than the primary. A `clui-<uuid>` tail is
 * meaningless to read, so it is shortened.
 */
export function gatewaySessionLabel(sessionKey: string, displayName?: string | null): string {
  const named = (displayName ?? '').trim()
  if (named) return named
  const tail = deriveGatewayLabel(sessionKey)
  if (isCluiSessionKey(sessionKey)) {
    const id = tail.slice('clui-'.length)
    return id ? `Tab ${id.slice(0, 8)}` : tail
  }
  return tail
}
