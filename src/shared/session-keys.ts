/**
 * Naming helpers for gateway session keys.
 *
 * Lives in `shared/` because both sides need it and neither may reach the
 * other: the renderer must never import `src/main`, and `src/main` must never
 * import `sidecar/`. Keep it dependency-free.
 */

/**
 * The human-facing tail of a gateway session key.
 *
 * A key is `agent:<agentId>:<name>`, where the name may itself contain colons.
 * Only the `agent:<id>:` prefix is stripped — nothing else is interpreted.
 *
 *   'agent:main:main'                     -> 'main'
 *   'agent:main:clui-a7105ce4-7dda-…'     -> 'clui-a7105ce4-7dda-…'
 *   'agent:main:cron:99801675-8f3c-…'     -> 'cron:99801675-8f3c-…'
 *   'no-colons-here'                      -> 'no-colons-here'
 *
 * Never throws and never returns an empty string for a non-empty input.
 */
export function deriveGatewayLabel(sessionKey: string): string {
  const key = String(sessionKey ?? '')
  const parts = key.split(':')
  const tail = parts.length >= 3 ? parts.slice(2).join(':') : key
  return tail || key
}

/**
 * True for the keys this app generates for its own tabs (`clui-<tabId>`).
 *
 * These are the sessions a user is most likely to be looking for — they are
 * their own past conversations in this UI — but they are also the ones the
 * gateway has no `displayName` for, so the picker labels them itself.
 */
export function isCluiSessionKey(sessionKey: string): boolean {
  return deriveGatewayLabel(sessionKey).startsWith('clui-')
}

/**
 * What to show for a gateway session.
 *
 * The gateway supplies a `displayName` for sessions created through its own
 * surfaces ('Nova Node Permissions Issue', 'Cron: daily-morning-briefing') but
 * not for the ones this app opens, so the key is the fallback rather than the
 * primary. A `clui-<uuid>` tail is meaningless to read, so it is shortened.
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
