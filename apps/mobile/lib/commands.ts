/**
 * Slash commands.
 *
 * Two kinds, and conflating them is the mistake worth avoiding: some commands
 * are things the *app* does (open the model picker, export the transcript,
 * clear what is on screen) and some are things the *agent* does, which are just
 * message text that happens to start with a slash.
 *
 * Sending `/model` to the gateway when the user wanted the picker gets a prose
 * answer about the current model and no picker. Intercepting `/compact` locally
 * would swallow a real runtime command. So each entry declares which it is, and
 * anything the gateway advertises through `commands.list` that this app has no
 * local handler for is passed straight through as text.
 */
import type { GatewayCommand } from '@openclaw/protocol'

/** What selecting a command should do. */
export type CommandAction =
  | 'model'
  | 'agent'
  | 'permissions'
  | 'cost'
  | 'clear'
  | 'export'
  | 'search'
  | 'skills'
  | 'send'

export interface SlashCommand {
  command: string
  description: string
  action: CommandAction
  /** Set for gateway-advertised commands, for the source label. */
  source?: string
}

/**
 * Commands the app handles itself.
 *
 * `/clear` clears the *local* transcript only, and its description says so.
 * A phone cannot truncate the gateway's stored history, and a `/clear` that
 * silently means something different here than in the CLI is worse than one
 * that is explicit about being a view-level action.
 */
export const LOCAL_COMMANDS: readonly SlashCommand[] = [
  { command: '/model', description: 'Choose the model for this session', action: 'model' },
  { command: '/agent', description: 'Choose which agent answers', action: 'agent' },
  { command: '/permissions', description: 'Change how tool approvals are handled', action: 'permissions' },
  { command: '/cost', description: 'Token usage and estimated cost', action: 'cost' },
  { command: '/search', description: 'Search this conversation', action: 'search' },
  { command: '/export', description: 'Export the transcript', action: 'export' },
  { command: '/skills', description: 'Browse and install skills', action: 'skills' },
  { command: '/clear', description: 'Clear the transcript on this device only', action: 'clear' },
]

/**
 * The local set plus whatever the gateway advertises.
 *
 * A gateway command whose name collides with a local one loses: the local
 * handler is the more useful behaviour on a phone, and two rows reading
 * `/model` would be indistinguishable.
 */
export function mergeCommands(gateway: readonly GatewayCommand[]): SlashCommand[] {
  const merged = [...LOCAL_COMMANDS]
  const taken = new Set(merged.map((c) => c.command))

  for (const raw of gateway) {
    const name = (raw.command ?? raw.name ?? '').trim()
    if (!name) continue
    const command = name.startsWith('/') ? name : `/${name}`
    if (taken.has(command)) continue
    taken.add(command)
    merged.push({
      command,
      description: (raw.description ?? '').trim() || 'Runtime command',
      action: 'send',
      source: raw.source,
    })
  }

  return merged
}

/**
 * The command menu's current query, or `null` when it should not be open.
 *
 * Only a slash at the very start of the draft counts. Matching anywhere would
 * pop the menu up in the middle of a file path, which is both the most common
 * thing typed into this box and the most annoying place to lose the keyboard.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  // A space ends the command: `/model haiku` is an argument being typed, not a
  // command still being chosen.
  if (/\s/.test(draft)) return null
  return draft
}

export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.toLowerCase()
  return commands.filter((c) => c.command.toLowerCase().startsWith(needle))
}
