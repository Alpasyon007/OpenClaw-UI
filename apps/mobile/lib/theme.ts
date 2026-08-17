/**
 * Theme — the desktop's, derived identically.
 *
 * An earlier revision hand-picked a palette that merely looked plausible: cold
 * near-black surfaces and a gold accent. The product's actual identity is warm
 * browns and OpenClaw red (`#e24a4a`), so the two surfaces looked like
 * different applications. This module derives the same ~68 tokens from the same
 * ten seeds via `@openclaw/theme`, so they cannot drift again.
 *
 * **React Native cannot use every token.** Several are CSS strings —
 * `containerShadow`, `cardShadow`, `popoverShadow` are `box-shadow` values, and
 * RN wants `shadowColor`/`shadowOffset`/`elevation` instead. They are carried
 * through rather than dropped (the palette shape is shared) but must not be
 * passed to a style prop; {@link elevation} is the RN-shaped substitute.
 */
import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { create } from 'zustand'
import {
  BUILT_IN_THEMES,
  derivePalette,
  type ColorPalette,
  type Theme,
} from '@openclaw/theme'

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeStore {
  mode: ThemeMode
  themeId: string
  setMode: (mode: ThemeMode) => void
  setThemeId: (id: string) => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  mode: 'system',
  themeId: BUILT_IN_THEMES[0]?.id ?? 'openclaw',
  setMode: (mode) => set({ mode }),
  setThemeId: (themeId) => set({ themeId }),
}))

export function availableThemes(): Theme[] {
  return [...BUILT_IN_THEMES]
}

function themeById(id: string): Theme {
  return BUILT_IN_THEMES.find((t) => t.id === id) ?? BUILT_IN_THEMES[0]
}

/**
 * The active palette.
 *
 * Memoised on the three inputs that can change it — derivation walks every
 * token and runs contrast fixes, which is not something to repeat on each
 * render of a streaming transcript.
 */
export function useColors(): ColorPalette {
  const systemScheme = useColorScheme()
  const mode = useThemeStore((s) => s.mode)
  const themeId = useThemeStore((s) => s.themeId)

  const isDark = mode === 'system' ? systemScheme !== 'light' : mode === 'dark'

  return useMemo(() => {
    const theme = themeById(themeId)
    return derivePalette(
      isDark ? theme.dark : theme.light,
      theme.effects,
      isDark,
      theme.overrides?.[isDark ? 'dark' : 'light'],
    )
  }, [themeId, isDark])
}

/** Whether the active mode resolves to dark. Drives status bar style. */
export function useIsDark(): boolean {
  const systemScheme = useColorScheme()
  const mode = useThemeStore((s) => s.mode)
  return mode === 'system' ? systemScheme !== 'light' : mode === 'dark'
}

/** Branding — app name, greeting, placeholder — from the active theme. */
export function useBranding() {
  const themeId = useThemeStore((s) => s.themeId)
  return useMemo(() => themeById(themeId).branding, [themeId])
}

/** Radii scale from the theme's base radius, as they do on the desktop. */
export function useRadii() {
  const themeId = useThemeStore((s) => s.themeId)
  return useMemo(() => {
    const base = themeById(themeId).effects.radius
    return { sm: base * 0.5, md: base, lg: base * 1.5, pill: 999 }
  }, [themeId])
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const

/**
 * Static radii matching the default theme's base radius.
 *
 * {@link useRadii} is the theme-aware version; this exists because most call
 * sites sit inside a StyleSheet that never varies by theme, and threading a
 * hook through those buys nothing.
 */
export const radius = { sm: 6, md: 12, lg: 18, pill: 999 } as const

export const font = {
  mono: 'monospace',
  size: { xs: 10, sm: 12, md: 14, lg: 16, xl: 20 },
} as const

/**
 * RN-shaped elevation, since the palette's shadow tokens are CSS strings.
 *
 * Android ignores `shadow*` and uses `elevation`; iOS ignores `elevation`. Both
 * are set so a component reads the same on either platform.
 */
export function elevation(level: 'card' | 'popover' = 'card') {
  const depth = level === 'popover' ? 8 : 2
  return {
    elevation: depth,
    shadowColor: '#000',
    shadowOpacity: level === 'popover' ? 0.3 : 0.18,
    shadowRadius: depth * 2,
    shadowOffset: { width: 0, height: depth / 2 },
  }
}

/** Status colour for a run or connection state, using real palette tokens. */
export function statusColor(colors: ColorPalette, state: string): string {
  switch (state) {
    case 'ready':
    case 'connected':
    case 'complete':
      return colors.statusComplete
    case 'streaming':
    case 'connecting':
    case 'running':
      return colors.statusRunning
    case 'pairing':
    case 'unsupported':
      return colors.statusPermission
    case 'error':
    case 'failed':
    case 'denied':
    case 'unavailable':
      return colors.statusError
    default:
      return colors.statusIdle
  }
}
