/**
 * Theme — the desktop's, derived identically, and now authorable here too.
 *
 * An earlier revision hand-picked a palette that merely looked plausible: cold
 * near-black surfaces and a gold accent. The product's actual identity is warm
 * browns and OpenClaw red (`#e24a4a`), so the two surfaces looked like
 * different applications. This module derives the same ~68 tokens from the same
 * ten seeds via `@openclaw/theme`, so they cannot drift again — and a theme the
 * user writes here derives through exactly the same path, which is what makes a
 * custom theme a real theme rather than a few overridden colours.
 *
 * **React Native cannot use every token.** Several are CSS strings —
 * `containerShadow`, `cardShadow`, `popoverShadow` are `box-shadow` values, and
 * RN wants `shadowColor`/`shadowOffset`/`elevation` instead. They are carried
 * through rather than dropped (the palette shape is shared) but must not be
 * passed to a style prop; {@link elevation} is the RN-shaped substitute.
 */
import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'
import {
  BUILT_IN_THEMES,
  derivePalette,
  validateTheme,
  type ColorPalette,
  type Theme,
  type ThemeBranding,
} from '@openclaw/theme'
import { readDoc, writeDoc } from './storage'

export type ThemeMode = 'system' | 'light' | 'dark'

const DOC = 'theme'

/** Legacy keys. Read once during hydration, then never again — see `hydrate`. */
const LEGACY_MODE_KEY = 'openclaw.theme.mode'
const LEGACY_THEME_KEY = 'openclaw.theme.id'

/** The brand theme. Falls back only if the presets are ever emptied. */
const DEFAULT_THEME_ID = BUILT_IN_THEMES[0]?.id ?? 'openclaw'

interface ThemeDoc {
  mode?: ThemeMode
  themeId?: string
  custom?: Theme[]
}

interface ThemeStore {
  mode: ThemeMode
  themeId: string
  /** User-authored themes, newest last. */
  custom: Theme[]
  /** False until stored preferences have been read. */
  hydrated: boolean
  setMode: (mode: ThemeMode) => void
  setThemeId: (id: string) => void
  /** Insert or replace by id. Returns false when the write failed. */
  saveTheme: (theme: Theme) => Promise<boolean>
  deleteTheme: (id: string) => Promise<void>
  hydrate: () => Promise<void>
}

const isMode = (v: unknown): v is ThemeMode => v === 'system' || v === 'light' || v === 'dark'
const isDoc = (v: unknown): v is ThemeDoc => !!v && typeof v === 'object' && !Array.isArray(v)

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: 'system',
  themeId: DEFAULT_THEME_ID,
  custom: [],
  hydrated: false,

  setMode: (mode) => {
    set({ mode })
    void persist(get())
  },

  setThemeId: (themeId) => {
    set({ themeId })
    void persist(get())
  },

  async saveTheme(theme) {
    set((s) => {
      const index = s.custom.findIndex((t) => t.id === theme.id)
      if (index < 0) return { custom: [...s.custom, theme] }
      const next = [...s.custom]
      next[index] = theme
      return { custom: next }
    })
    return persist(get())
  },

  async deleteTheme(id) {
    set((s) => ({
      custom: s.custom.filter((t) => t.id !== id),
      // Deleting the active theme has to move the selection too, or the app
      // derives from `undefined` and renders a blank screen.
      themeId: s.themeId === id ? DEFAULT_THEME_ID : s.themeId,
    }))
    await persist(get())
  },

  /**
   * Restore stored preferences.
   *
   * Both values are validated against what actually exists rather than trusted:
   * a theme id from an older build whose preset has since been removed would
   * otherwise leave the app deriving from `undefined` and rendering nothing.
   *
   * The legacy SecureStore keys are read once and migrated. They were used
   * because SecureStore was the only store in the build at the time; it is the
   * wrong home for a display preference and, more practically, Android does not
   * reliably store values past a couple of kilobytes — which a set of custom
   * themes exceeds immediately.
   */
  async hydrate() {
    try {
      const doc = await readDoc<ThemeDoc>(DOC, {}, isDoc)

      let mode = isMode(doc.mode) ? doc.mode : null
      let themeId = typeof doc.themeId === 'string' ? doc.themeId : null

      if (!mode || !themeId) {
        const [legacyMode, legacyTheme] = await Promise.all([
          SecureStore.getItemAsync(LEGACY_MODE_KEY).catch(() => null),
          SecureStore.getItemAsync(LEGACY_THEME_KEY).catch(() => null),
        ])
        mode = mode ?? (isMode(legacyMode) ? legacyMode : 'system')
        themeId = themeId ?? legacyTheme
      }

      // Only themes that survive validation are adopted. A malformed one from a
      // partially-written file would otherwise take the whole list with it.
      const custom = (doc.custom ?? []).flatMap((raw) => {
        const parsed = validateTheme(raw)
        return parsed.ok ? [parsed.theme] : []
      })

      const known = [...BUILT_IN_THEMES, ...custom]
      set({
        mode: mode ?? 'system',
        themeId: known.some((t) => t.id === themeId) ? (themeId as string) : DEFAULT_THEME_ID,
        custom,
        hydrated: true,
      })

      // Fold the migration back to disk so the legacy keys stop being consulted.
      void persist(get())
    } catch {
      // A store that cannot be read is not a reason to fail to render.
      set({ hydrated: true })
    }
  },
}))

async function persist(state: ThemeStore): Promise<boolean> {
  return writeDoc(DOC, {
    mode: state.mode,
    themeId: state.themeId,
    custom: state.custom,
  } satisfies ThemeDoc)
}

/** Built-ins first, then anything the user wrote. */
export function availableThemes(): Theme[] {
  return [...BUILT_IN_THEMES, ...useThemeStore.getState().custom]
}

/** Reactive version, for screens that must re-render when a theme is saved. */
export function useAvailableThemes(): Theme[] {
  const custom = useThemeStore((s) => s.custom)
  return useMemo(() => [...BUILT_IN_THEMES, ...custom], [custom])
}

export function themeById(id: string): Theme {
  const custom = useThemeStore.getState().custom
  return (
    BUILT_IN_THEMES.find((t) => t.id === id) ??
    custom.find((t) => t.id === id) ??
    BUILT_IN_THEMES[0]
  )
}

/** Whether a theme can be edited in place, or must be duplicated first. */
export function isBuiltIn(id: string): boolean {
  return BUILT_IN_THEMES.some((t) => t.id === id)
}

/**
 * The active palette.
 *
 * Memoised on the inputs that can change it — derivation walks every token and
 * runs contrast fixes, which is not something to repeat on each render of a
 * streaming transcript. `custom` is a dependency because editing the active
 * theme must repaint immediately; it is a stable reference between edits, so
 * this does not re-derive on unrelated renders.
 */
export function useColors(): ColorPalette {
  const systemScheme = useColorScheme()
  const mode = useThemeStore((s) => s.mode)
  const themeId = useThemeStore((s) => s.themeId)
  const custom = useThemeStore((s) => s.custom)

  const isDark = mode === 'system' ? systemScheme !== 'light' : mode === 'dark'

  return useMemo(() => {
    const theme =
      BUILT_IN_THEMES.find((t) => t.id === themeId) ??
      custom.find((t) => t.id === themeId) ??
      BUILT_IN_THEMES[0]
    return derivePalette(
      isDark ? theme.dark : theme.light,
      theme.effects,
      isDark,
      theme.overrides?.[isDark ? 'dark' : 'light'],
    )
  }, [themeId, isDark, custom])
}

/**
 * Derive an arbitrary theme's palette without selecting it.
 *
 * The editor needs this: previewing by applying the theme means every unsaved
 * keystroke repaints the whole app, including the editor's own chrome, which
 * makes a half-typed hex code briefly unreadable.
 */
export function paletteFor(theme: Theme, isDark: boolean): ColorPalette {
  return derivePalette(
    isDark ? theme.dark : theme.light,
    theme.effects,
    isDark,
    theme.overrides?.[isDark ? 'dark' : 'light'],
  )
}

/** Whether the active mode resolves to dark. Drives status bar style. */
export function useIsDark(): boolean {
  const systemScheme = useColorScheme()
  const mode = useThemeStore((s) => s.mode)
  return mode === 'system' ? systemScheme !== 'light' : mode === 'dark'
}

/**
 * Branding outside React.
 *
 * The permission and dictation messages name the product, and they are built in
 * plain modules that cannot call a hook. Reading the store directly keeps those
 * strings following the active theme instead of hardcoding a name the user may
 * have changed in the editor.
 */
export function brandingNow(): ThemeBranding {
  const { themeId, custom } = useThemeStore.getState()
  return (
    BUILT_IN_THEMES.find((t) => t.id === themeId) ??
    custom.find((t) => t.id === themeId) ??
    BUILT_IN_THEMES[0]
  ).branding
}

/** Branding — app name, greeting, placeholder — from the active theme. */
export function useBranding() {
  const themeId = useThemeStore((s) => s.themeId)
  const custom = useThemeStore((s) => s.custom)
  return useMemo(
    () =>
      (BUILT_IN_THEMES.find((t) => t.id === themeId) ??
        custom.find((t) => t.id === themeId) ??
        BUILT_IN_THEMES[0]).branding,
    [themeId, custom],
  )
}

/** Radii scale from the theme's base radius, as they do on the desktop. */
export function useRadii() {
  const themeId = useThemeStore((s) => s.themeId)
  const custom = useThemeStore((s) => s.custom)
  return useMemo(() => {
    const base = (
      BUILT_IN_THEMES.find((t) => t.id === themeId) ??
      custom.find((t) => t.id === themeId) ??
      BUILT_IN_THEMES[0]
    ).effects.radius
    return { sm: base * 0.5, md: base, lg: base * 1.5, pill: 999 }
  }, [themeId, custom])
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
