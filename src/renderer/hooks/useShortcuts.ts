import { useEffect, useState } from 'react'
import { getShortcuts, formatShortcut, type ShortcutDef, type ShortcutId } from '../../shared/shortcuts'

/**
 * Platform-correct shortcut labels.
 *
 * The renderer cannot read `process.platform`, so the main process supplies it.
 * Until it arrives we render the table for the platform the bundle was built
 * against — the labels differ, but nothing depends on them being right for the
 * first frame.
 */
export function useShortcuts(): { platform: string; shortcuts: ShortcutDef[]; format: (id: ShortcutId) => string } {
  const [platform, setPlatform] = useState<string>('')
  const [shortcuts, setShortcuts] = useState<ShortcutDef[]>(() => getShortcuts(''))

  useEffect(() => {
    let cancelled = false
    window.clui
      .getShortcuts()
      .then((res) => {
        if (cancelled) return
        setPlatform(res.platform)
        setShortcuts(res.shortcuts)
      })
      .catch(() => {
        // Keep the build-time default table.
      })
    return () => { cancelled = true }
  }, [])

  const format = (id: ShortcutId): string => {
    const def = shortcuts.find((s) => s.id === id)
    return def ? formatShortcut(def, platform) : ''
  }

  return { platform, shortcuts, format }
}
