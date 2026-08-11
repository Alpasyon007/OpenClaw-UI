/**
 * CLUI Design Tokens — Dual theme (dark + light)
 * Colors derived from ChatCN oklch system and design-fixed.html reference.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { derivePalette } from './theme-derive'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, findBuiltIn } from './theme-presets'
import { validateTheme, type Theme } from '../shared/theme-types'

export { BUILT_IN_THEMES }

// ─── Color palettes ───

const darkColors = {
  // Container (glass surfaces)
  containerBg: '#242422',
  containerBgCollapsed: '#21211e',
  containerBorder: '#3b3b36',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.35), 0 1px 6px rgba(0, 0, 0, 0.25)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.35)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.4)',

  // Surface layers
  surfacePrimary: '#353530',
  surfaceSecondary: '#42423d',
  surfaceHover: 'rgba(255, 255, 255, 0.05)',
  surfaceActive: 'rgba(255, 255, 255, 0.08)',

  // Input
  inputBg: 'transparent',
  inputBorder: '#3b3b36',
  inputFocusBorder: 'rgba(217, 119, 87, 0.4)',
  inputPillBg: '#2a2a27',

  // Text
  textPrimary: '#ccc9c0',
  textSecondary: '#c0bdb2',
  textTertiary: '#76766e',
  textMuted: '#353530',

  // Accent — OpenClaw red
  accent: '#e24a4a',
  accentLight: 'rgba(226, 74, 74, 0.12)',
  accentSoft: 'rgba(226, 74, 74, 0.18)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#e24a4a',
  statusRunningBg: 'rgba(226, 74, 74, 0.12)',
  statusComplete: '#7aac8c',
  statusCompleteBg: 'rgba(122, 172, 140, 0.1)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.08)',
  statusDead: '#c47060',
  statusPermission: '#e24a4a',
  statusPermissionGlow: 'rgba(226, 74, 74, 0.4)',

  // Tab
  tabActive: '#353530',
  tabActiveBorder: '#4a4a45',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.05)',

  // User message bubble
  userBubble: '#353530',
  userBubbleBorder: '#4a4a45',
  userBubbleText: '#ccc9c0',

  // Tool card
  toolBg: '#353530',
  toolBorder: '#4a4a45',
  toolRunningBorder: 'rgba(217, 119, 87, 0.3)',
  toolRunningBg: 'rgba(217, 119, 87, 0.05)',

  // Timeline
  timelineLine: '#353530',
  timelineNode: 'rgba(217, 119, 87, 0.2)',
  timelineNodeActive: '#d97757',

  // Scrollbar
  scrollThumb: 'rgba(255, 255, 255, 0.15)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.25)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#e24a4a',
  sendHover: '#cd3f3f',
  sendDisabled: 'rgba(226, 74, 74, 0.3)',

  // Popover
  popoverBg: '#292927',
  popoverBorder: '#3b3b36',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)',

  // Code block
  codeBg: '#1a1a18',

  // Mic button
  micBg: '#353530',
  micColor: '#c0bdb2',
  micDisabled: '#42423d',

  // Placeholder
  placeholder: '#6b6b60',

  // Disabled button color
  btnDisabled: '#42423d',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#c0bdb2',
  btnHoverBg: '#302f2d',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(226, 74, 74, 0.2)',
  accentBorderMedium: 'rgba(226, 74, 74, 0.28)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',
} as const

const lightColors = {
  // Container (glass surfaces)
  containerBg: '#f9f8f5',
  containerBgCollapsed: '#f4f2ed',
  containerBorder: '#dddad2',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.08), 0 1px 6px rgba(0, 0, 0, 0.04)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.06)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.08)',

  // Surface layers
  surfacePrimary: '#edeae0',
  surfaceSecondary: '#dddad2',
  surfaceHover: 'rgba(0, 0, 0, 0.04)',
  surfaceActive: 'rgba(0, 0, 0, 0.06)',

  // Input
  inputBg: 'transparent',
  inputBorder: '#dddad2',
  inputFocusBorder: 'rgba(217, 119, 87, 0.4)',
  inputPillBg: '#ffffff',

  // Text
  textPrimary: '#3c3929',
  textSecondary: '#5a5749',
  textTertiary: '#8a8a80',
  textMuted: '#dddad2',

  // Accent — OpenClaw red
  accent: '#e24a4a',
  accentLight: 'rgba(226, 74, 74, 0.12)',
  accentSoft: 'rgba(226, 74, 74, 0.15)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#e24a4a',
  statusRunningBg: 'rgba(226, 74, 74, 0.12)',
  statusComplete: '#5a9e6f',
  statusCompleteBg: 'rgba(90, 158, 111, 0.1)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.06)',
  statusDead: '#c47060',
  statusPermission: '#e24a4a',
  statusPermissionGlow: 'rgba(226, 74, 74, 0.3)',

  // Tab
  tabActive: '#edeae0',
  tabActiveBorder: '#dddad2',
  tabInactive: 'transparent',
  tabHover: 'rgba(0, 0, 0, 0.04)',

  // User message bubble
  userBubble: '#edeae0',
  userBubbleBorder: '#dddad2',
  userBubbleText: '#3c3929',

  // Tool card
  toolBg: '#edeae0',
  toolBorder: '#dddad2',
  toolRunningBorder: 'rgba(217, 119, 87, 0.3)',
  toolRunningBg: 'rgba(217, 119, 87, 0.05)',

  // Timeline
  timelineLine: '#dddad2',
  timelineNode: 'rgba(217, 119, 87, 0.2)',
  timelineNodeActive: '#d97757',

  // Scrollbar
  scrollThumb: 'rgba(0, 0, 0, 0.1)',
  scrollThumbHover: 'rgba(0, 0, 0, 0.18)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#e24a4a',
  sendHover: '#cd3f3f',
  sendDisabled: 'rgba(226, 74, 74, 0.3)',

  // Popover
  popoverBg: '#f9f8f5',
  popoverBorder: '#dddad2',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.06)',

  // Code block
  codeBg: '#f0eee8',

  // Mic button
  micBg: '#edeae0',
  micColor: '#5a5749',
  micDisabled: '#c8c5bc',

  // Placeholder
  placeholder: '#b0ada4',

  // Disabled button color
  btnDisabled: '#c8c5bc',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#3c3929',
  btnHoverBg: '#edeae0',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(226, 74, 74, 0.2)',
  accentBorderMedium: 'rgba(226, 74, 74, 0.28)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',
} as const

export type ColorPalette = { [K in keyof typeof darkColors]: string }

/**
 * The original hardcoded palettes are retained purely as the shape reference
 * for ColorPalette and as a last-resort fallback. Live colours come from
 * derivePalette() against the active theme's seeds.
 */

// ─── Theme store ───

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeState {
  isDark: boolean
  themeMode: ThemeMode
  soundEnabled: boolean
  /** Which configured width the launcher is currently using. */
  widthMode: WidthMode
  /** Width used when full width is off. */
  standardWidth: WidthSetting
  /** Width used when full width is on. */
  fullWidth: WidthSetting
  /** OS-reported dark mode — used when themeMode is 'system' */
  _systemIsDark: boolean
  /** The active theme (built-in or user-authored). */
  theme: Theme
  /** User-authored themes, persisted locally. */
  customThemes: Theme[]
  /** Derived palette for the current theme + mode. */
  palette: ColorPalette
  setIsDark: (isDark: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setSoundEnabled: (enabled: boolean) => void
  /** Switch between the standard and full width. */
  setWidthMode: (mode: WidthMode) => void
  /** Redefine what one of the two widths means. */
  setWidthSetting: (mode: WidthMode, setting: WidthSetting) => void
  /** Called by OS theme change listener — updates system value */
  setSystemTheme: (isDark: boolean) => void
  /** Switch to a theme by id (built-in or custom). */
  selectTheme: (id: string) => void
  /** Create or update a custom theme and make it active. */
  upsertCustomTheme: (theme: Theme) => void
  /** Patch the active theme; auto-forks built-ins into an editable copy. */
  updateActiveTheme: (patch: DeepPartial<Theme>) => void
  deleteCustomTheme: (id: string) => void
  /** Restore the shipped default. */
  resetTheme: () => void
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Convert camelCase token name to --clui-kebab-case CSS custom property */
function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

/** Sync all JS design tokens to CSS custom properties on :root */
function syncTokensToCss(tokens: ColorPalette): void {
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(tokens)) {
    style.setProperty(`--clui-${camelToKebab(key)}`, value)
  }
}

/** Non-colour theme values that CSS also needs. */
function syncThemeShapeToCss(theme: Theme): void {
  const style = document.documentElement.style
  const fx = theme.effects || { radius: 20, glow: 0.6, blur: 18 }
  style.setProperty('--clui-radius', `${fx.radius}px`)
  style.setProperty('--clui-radius-sm', `${Math.max(2, Math.round(fx.radius * 0.5))}px`)
  style.setProperty('--clui-radius-lg', `${Math.round(fx.radius * 1.2)}px`)
  style.setProperty('--clui-blur', `${fx.blur}px`)
  style.setProperty('--clui-glow', String(fx.glow))
  style.setProperty('--clui-font-sans', theme.typography?.sans || 'system-ui, sans-serif')
  style.setProperty('--clui-font-mono', theme.typography?.mono || 'ui-monospace, monospace')
}

/** Compute the palette for a theme in a given mode. */
function paletteFor(theme: Theme, isDark: boolean): ColorPalette {
  try {
    const seeds = isDark ? theme.dark : theme.light
    const overrides = isDark ? theme.overrides?.dark : theme.overrides?.light
    return derivePalette(seeds, theme.effects, isDark, overrides as Partial<ColorPalette> | undefined)
  } catch {
    // A malformed theme must never leave the app unrenderable.
    return isDark ? darkColors : lightColors
  }
}

function applyTheme(isDark: boolean, theme: Theme): void {
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  syncTokensToCss(paletteFor(theme, isDark))
  syncThemeShapeToCss(theme)
}

// ─── Panel width ───
//
// The launcher keeps its two states — full and standard — but what each one
// *means* is now the user's to set, in px or as a share of the screen. The
// quick-settings toggle just picks which of the two is active.
//
// A width in px is absolute; a percentage is resolved against the width of the
// display the launcher is on, so the same setting suits a 13" laptop and an
// ultrawide. Either way the native window is resized to match (see
// SET_WINDOW_WIDTH in src/main/index.ts) — without that, anything wider than
// the window is clipped rather than shown.

export type WidthUnit = 'px' | 'percent'

export interface WidthSetting {
  unit: WidthUnit
  /** Pixels when unit is 'px'; percent of screen width when 'percent'. */
  value: number
}

/** Which of the two configured widths is active. */
export type WidthMode = 'standard' | 'full'

export const PANEL_WIDTH_MIN = 320
/**
 * Room the native window needs beyond the panel for the card's shadow and
 * glow. Also the gap kept from the screen edge when a width would overflow.
 */
export const PANEL_WINDOW_MARGIN = 60

/** Defaults reproduce the original two states exactly. */
export const DEFAULT_STANDARD_WIDTH: WidthSetting = { unit: 'px', value: 460 }
export const DEFAULT_FULL_WIDTH: WidthSetting = { unit: 'px', value: 700 }

export const PANEL_PERCENT_MIN = 15
export const PANEL_PERCENT_MAX = 100

/** Widest panel a display can actually show, leaving the window its margin. */
export function maxPanelWidthFor(screenWidth: number): number {
  const usable = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : 1440
  return Math.max(PANEL_WIDTH_MIN, Math.round(usable - PANEL_WINDOW_MARGIN))
}

export function clampPanelWidth(px: number, screenWidth: number): number {
  if (!Number.isFinite(px)) return DEFAULT_STANDARD_WIDTH.value
  return Math.round(Math.min(maxPanelWidthFor(screenWidth), Math.max(PANEL_WIDTH_MIN, px)))
}

/** Turn a stored setting into the px the layout should actually use. */
export function resolveWidth(setting: WidthSetting, screenWidth: number): number {
  const raw = setting.unit === 'percent'
    ? (screenWidth * setting.value) / 100
    : setting.value
  return clampPanelWidth(raw, screenWidth)
}

/** Normalize a setting read from disk — unit and range are both untrusted. */
export function sanitizeWidthSetting(raw: unknown, fallback: WidthSetting): WidthSetting {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Partial<WidthSetting>
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return fallback
  if (r.unit === 'percent') {
    return { unit: 'percent', value: Math.min(PANEL_PERCENT_MAX, Math.max(PANEL_PERCENT_MIN, Math.round(r.value))) }
  }
  if (r.unit === 'px') {
    // Not clamped to a screen here: settings load before a display is known,
    // and resolveWidth clamps against the real one at render time.
    return { unit: 'px', value: Math.max(PANEL_WIDTH_MIN, Math.round(r.value)) }
  }
  return fallback
}

/**
 * Heights that track the chosen width. A wider panel that stayed short would
 * read as a letterbox, so the conversation grows with it — capped well inside
 * the fixed native window height so the top of the column is never clipped.
 */
export function panelMetrics(panelWidth: number): {
  /** Width of the collapsed (single-line) card. */
  collapsedWidth: number
  /** Max height of the expanded card body (conversation + status bar). */
  bodyMaxHeight: number
  /** Max height of the scrollable message list. */
  conversationMaxHeight: number
  /** Width of the onboarding panel, which sits above the shell. */
  onboardingWidth: number
} {
  const w = Math.max(PANEL_WIDTH_MIN, Math.round(panelWidth))
  // Anchored on the old default so an upgraded install is pixel-identical at
  // 460px, then half a pixel of height per pixel of width. The ceilings keep
  // the column inside the fixed native window (PILL_HEIGHT, 720px) once the tab
  // row, input pill, and margins are accounted for.
  const grow = (base: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, base + (w - DEFAULT_STANDARD_WIDTH.value) * 0.5)))
  return {
    collapsedWidth: w - 30,
    bodyMaxHeight: grow(400, 370, 540),
    conversationMaxHeight: grow(336, 306, 476),
    onboardingWidth: Math.min(720, Math.max(620, w + 20)),
  }
}

const SETTINGS_KEY = 'clui-settings'

interface PersistedSettings {
  themeMode: ThemeMode
  soundEnabled: boolean
  widthMode: WidthMode
  standardWidth: WidthSetting
  fullWidth: WidthSetting
  themeId: string
  customThemes: Theme[]
}

function loadSettings(): PersistedSettings {
  const fallback: PersistedSettings = {
    themeMode: 'dark', soundEnabled: true,
    widthMode: 'standard',
    standardWidth: DEFAULT_STANDARD_WIDTH,
    fullWidth: DEFAULT_FULL_WIDTH,
    themeId: DEFAULT_THEME_ID, customThemes: [],
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    // Custom themes are user data that becomes live CSS — validate each one
    // rather than trusting whatever is in localStorage.
    const customThemes: Theme[] = Array.isArray(parsed.customThemes)
      ? parsed.customThemes
          .map((t: unknown) => validateTheme(t))
          .filter((r: any) => r.ok)
          .map((r: any) => r.theme)
      : []
    return {
      themeMode: ['light', 'dark', 'system'].includes(parsed.themeMode) ? parsed.themeMode : 'dark',
      soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
      // Two earlier shapes migrate in: the original `expandedUI` on/off flag,
      // and the single `panelWidth` that briefly replaced it. A single width
      // becomes the standard one, with full left at its default.
      widthMode: parsed.widthMode === 'full' || parsed.expandedUI === true ? 'full' : 'standard',
      standardWidth: sanitizeWidthSetting(
        parsed.standardWidth,
        typeof parsed.panelWidth === 'number'
          ? { unit: 'px', value: parsed.panelWidth }
          : DEFAULT_STANDARD_WIDTH,
      ),
      fullWidth: sanitizeWidthSetting(parsed.fullWidth, DEFAULT_FULL_WIDTH),
      themeId: typeof parsed.themeId === 'string' ? parsed.themeId : DEFAULT_THEME_ID,
      customThemes,
    }
  } catch {
    return fallback
  }
}

function saveSettings(s: PersistedSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch {}
}

// Respect persisted settings on launch (including the chosen panel width).
const saved = loadSettings()

function resolveTheme(id: string, customs: Theme[]): Theme {
  return findBuiltIn(id) || customs.find((t) => t.id === id) || findBuiltIn(DEFAULT_THEME_ID)!
}

const initialTheme = resolveTheme(saved.themeId, saved.customThemes)
const initialIsDark = saved.themeMode === 'light' ? false : true

export const useThemeStore = create<ThemeState>((set, get) => {
  /** Recompute the palette, push it to CSS, and persist. */
  const commit = (next: Partial<ThemeState>): void => {
    const s = { ...get(), ...next }
    const palette = paletteFor(s.theme, s.isDark)
    set({ ...next, palette } as Partial<ThemeState>)
    applyTheme(s.isDark, s.theme)
    saveSettings({
      themeMode: s.themeMode,
      soundEnabled: s.soundEnabled,
      widthMode: s.widthMode,
      standardWidth: s.standardWidth,
      fullWidth: s.fullWidth,
      themeId: s.theme.id,
      customThemes: s.customThemes,
    })
    // Branding renames what the user sees in the window title and tray.
    try {
      window.clui?.setBranding?.({
        appName: s.theme.branding.appName,
        tagline: s.theme.branding.tagline,
      })
    } catch {
      // Preload not ready yet — the next commit will carry it.
    }
  }

  return {
    isDark: initialIsDark,
    themeMode: saved.themeMode,
    soundEnabled: saved.soundEnabled,
    widthMode: saved.widthMode,
    standardWidth: saved.standardWidth,
    fullWidth: saved.fullWidth,
    _systemIsDark: true,
    theme: initialTheme,
    customThemes: saved.customThemes,
    palette: paletteFor(initialTheme, initialIsDark),

    setIsDark: (isDark) => commit({ isDark }),
    setThemeMode: (mode) => {
      const resolved = mode === 'system' ? get()._systemIsDark : mode === 'dark'
      commit({ themeMode: mode, isDark: resolved })
    },
    setSoundEnabled: (enabled) => commit({ soundEnabled: enabled }),
    setWidthMode: (mode) => commit({ widthMode: mode }),
    setWidthSetting: (mode, setting) => commit(
      mode === 'full'
        ? { fullWidth: sanitizeWidthSetting(setting, DEFAULT_FULL_WIDTH) }
        : { standardWidth: sanitizeWidthSetting(setting, DEFAULT_STANDARD_WIDTH) },
    ),
    setSystemTheme: (isDark) => {
      set({ _systemIsDark: isDark })
      if (get().themeMode === 'system') commit({ isDark })
    },

    selectTheme: (id) => {
      const theme = resolveTheme(id, get().customThemes)
      commit({ theme })
    },

    upsertCustomTheme: (theme) => {
      const check = validateTheme(theme)
      if (!check.ok) return
      const custom = { ...check.theme, builtIn: false }
      const rest = get().customThemes.filter((t) => t.id !== custom.id)
      commit({ customThemes: [...rest, custom], theme: custom })
    },

    updateActiveTheme: (patch) => {
      const current = get().theme
      // Built-ins are read-only: editing one forks it into a custom copy so
      // the shipped presets always remain available to return to.
      const base: Theme = current.builtIn
        ? { ...current, id: `${current.id}-custom-${Date.now().toString(36)}`, name: `${current.name} (custom)`, builtIn: false }
        : current

      const merged: Theme = {
        ...base,
        ...(patch as Partial<Theme>),
        dark: { ...base.dark, ...(patch.dark || {}) },
        light: { ...base.light, ...(patch.light || {}) },
        effects: { ...base.effects, ...(patch.effects || {}) },
        typography: { ...base.typography, ...(patch.typography || {}) },
        branding: { ...base.branding, ...(patch.branding || {}) },
        builtIn: false,
      }

      const rest = get().customThemes.filter((t) => t.id !== merged.id)
      commit({ customThemes: [...rest, merged], theme: merged })
    },

    deleteCustomTheme: (id) => {
      const customThemes = get().customThemes.filter((t) => t.id !== id)
      const theme = get().theme.id === id ? findBuiltIn(DEFAULT_THEME_ID)! : get().theme
      commit({ customThemes, theme })
    },

    resetTheme: () => commit({ theme: findBuiltIn(DEFAULT_THEME_ID)! }),
  }
})

// Initialize CSS vars with the saved theme before first paint.
applyTheme(initialIsDark, initialTheme)

/** Reactive hook — returns the active color palette */
export function useColors(): ColorPalette {
  return useThemeStore((s) => s.palette)
}

/**
 * Width of the display the launcher is on.
 *
 * Percentage widths are meaningless without it, and it changes when the window
 * is summoned onto another monitor — which is a move, not a resize, so the
 * summon broadcast is the signal that matters here, not just 'resize'.
 */
export function useScreenWidth(): number {
  const read = (): number => (typeof window === 'undefined' ? 1440 : window.screen?.availWidth || window.innerWidth || 1440)
  const [width, setWidth] = useState(read)

  useEffect(() => {
    const update = (): void => setWidth(read())
    window.addEventListener('resize', update)
    // Summoning can land the launcher on a different display.
    const off = window.clui?.onWindowShown?.(update)
    return () => {
      window.removeEventListener('resize', update)
      if (typeof off === 'function') off()
    }
  }, [])

  return width
}

/**
 * The chat column width to lay out with, in px.
 *
 * Also the point where the native window is told how much room to reserve: the
 * window is fixed-size by design (resizing it per frame fights the renderer's
 * expand animation), so it is re-sized only here, when the setting changes.
 */
export function usePanelWidth(): number {
  const mode = useThemeStore((s) => s.widthMode)
  const standard = useThemeStore((s) => s.standardWidth)
  const full = useThemeStore((s) => s.fullWidth)
  const screenWidth = useScreenWidth()

  const width = resolveWidth(mode === 'full' ? full : standard, screenWidth)

  useEffect(() => {
    try {
      window.clui?.setWindowWidth?.(width + PANEL_WINDOW_MARGIN)
    } catch {
      // Preload not ready — the next change carries it.
    }
  }, [width])

  return width
}

/** Reactive hook — the active theme's branding. */
export function useBranding(): Theme['branding'] {
  return useThemeStore((s) => s.theme.branding)
}

/** Non-reactive getter — use outside React components */
export function getColors(isDark: boolean): ColorPalette {
  const s = useThemeStore.getState()
  return s.isDark === isDark ? s.palette : paletteFor(s.theme, isDark)
}

// ─── Backward compatibility ───
// Legacy static export — components being migrated should use useColors() instead
export const colors = darkColors

// ─── Spacing ───

export const spacing = {
  contentWidth: 460,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

// ─── Animation ───

export const motion = {
  spring: { type: 'spring' as const, stiffness: 500, damping: 30 },
  easeOut: { duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] as const },
  fadeIn: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: { duration: 0.15 },
  },
} as const
