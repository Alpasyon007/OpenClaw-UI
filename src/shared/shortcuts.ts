/**
 * Global shortcut definitions, shared between the main and renderer processes.
 *
 * The renderer must never hardcode ⌘/⌥/⇧ glyphs: they are meaningless on
 * Windows and Linux, where the same accelerators resolve to Ctrl and Alt.
 * Render {@link ShortcutDef.keys} instead.
 */

export type ShortcutId =
  | 'toggle-launcher'
  | 'toggle-launcher-fallback'
  | 'toggle-marketplace'
  | 'open-agents'
  | 'open-settings'

export interface ShortcutDef {
  id: ShortcutId
  /** Electron accelerator. `CommandOrControl` resolves per platform. */
  accelerator: string
  /** Individual key caps for display, already platform-correct. */
  keys: string[]
  /** What the shortcut does, shown next to the keys. */
  action: string
}

/** True when rendering for macOS, which uses symbol glyphs rather than words. */
function isMac(platform: string): boolean {
  return platform === 'darwin'
}

/**
 * Build the shortcut table for a platform.
 *
 * Pass `process.platform` in main, or the value delivered over IPC in the
 * renderer — the renderer has no reliable synchronous platform source.
 */
export function getShortcuts(platform: string): ShortcutDef[] {
  const mac = isMac(platform)
  const mod = mac ? '⌘' : 'Ctrl'
  const shift = mac ? '⇧' : 'Shift'
  const alt = mac ? '⌥' : 'Alt'

  return [
    {
      id: 'toggle-launcher',
      accelerator: 'Alt+Space',
      keys: [alt, 'Space'],
      action: 'Toggle launcher',
    },
    {
      id: 'toggle-launcher-fallback',
      accelerator: 'CommandOrControl+Shift+K',
      keys: [mod, shift, 'K'],
      action: 'Toggle launcher (fallback)',
    },
    {
      id: 'toggle-marketplace',
      accelerator: 'CommandOrControl+Shift+M',
      keys: [mod, shift, 'M'],
      action: 'Open Community Skills',
    },
    {
      id: 'open-agents',
      accelerator: 'CommandOrControl+Shift+A',
      keys: [mod, shift, 'A'],
      action: 'Open Agents Control Center',
    },
    {
      id: 'open-settings',
      accelerator: 'CommandOrControl+Shift+S',
      keys: [mod, shift, 'S'],
      action: 'Open Settings Control Center',
    },
  ]
}

/** Render a shortcut as a single string, e.g. "Ctrl + Shift + K" or "⌘ ⇧ K". */
export function formatShortcut(def: ShortcutDef, platform: string): string {
  return def.keys.join(isMac(platform) ? ' ' : ' + ')
}

export function getShortcut(id: ShortcutId, platform: string): ShortcutDef {
  const found = getShortcuts(platform).find((s) => s.id === id)
  if (!found) throw new Error(`Unknown shortcut: ${id}`)
  return found
}
