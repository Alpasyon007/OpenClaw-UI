/**
 * Theme and branding contract.
 *
 * A theme is authored from a small set of SEEDS; the ~68 runtime colour tokens
 * the UI consumes are derived from them (see renderer/theme.ts). Authoring 68
 * tokens by hand is not something a user will do, so the editor exposes seeds
 * and the derivation fills in the rest — with `overrides` as the escape hatch
 * for anyone who wants a specific token exact.
 */

/** The handful of colours a theme is actually authored from. */
export interface ThemeSeeds {
  /** Primary action/brand colour — buttons, active states, running status. */
  accent: string
  /** Secondary accent for glows, timeline nodes and highlights. */
  accentAlt: string
  /** Deepest container background. */
  bg: string
  /** Raised surface: cards, tabs, tool blocks. */
  surface: string
  /** Hairline borders. */
  border: string
  /** Primary text. */
  text: string
  /** Secondary/tertiary text base. */
  textDim: string
  success: string
  warning: string
  danger: string
}

export interface ThemeEffects {
  /** Base corner radius in px; other radii scale from it. */
  radius: number
  /** 0..1 — how much accent glow/shadow to apply. */
  glow: number
  /** Backdrop blur in px for glass surfaces. */
  blur: number
}

export interface ThemeTypography {
  /** CSS font-family stack for UI text. */
  sans: string
  /** CSS font-family stack for code and terminal output. */
  mono: string
}

/**
 * User-visible product identity. Everything here is presentation only — it
 * must never be used for IPC channels, CLI arguments, or filesystem paths.
 */
export interface ThemeBranding {
  /** Product name shown in titles, tray and headings. */
  appName: string
  /** What the assistant is called in transcripts and exports. */
  assistantName: string
  tagline: string
  /** Empty-state line. */
  greeting: string
  inputPlaceholder: string
  /** Emoji or 1-2 characters used as a wordmark badge. */
  glyph: string
}

export interface Theme {
  id: string
  name: string
  /** Set on user-created themes; built-ins are read-only. */
  builtIn?: boolean
  dark: ThemeSeeds
  light: ThemeSeeds
  effects: ThemeEffects
  typography: ThemeTypography
  branding: ThemeBranding
  /**
   * Exact values for specific derived tokens, keyed by ColorPalette key.
   * Applied after derivation, per mode.
   */
  overrides?: {
    dark?: Record<string, string>
    light?: Record<string, string>
  }
}

/** What gets written to disk on export, so files are self-describing. */
export interface ThemeFile {
  kind: 'openclaw-ui-theme'
  version: 1
  theme: Theme
}

export const THEME_FILE_KIND = 'openclaw-ui-theme'
export const THEME_FILE_VERSION = 1

/** Narrow an unknown parsed JSON blob to a Theme, or explain why not. */
export function validateTheme(input: unknown): { ok: true; theme: Theme } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Not an object' }

  // Accept both a bare Theme and a wrapped ThemeFile.
  const raw = input as Record<string, any>
  const candidate: Record<string, any> = raw.kind === THEME_FILE_KIND ? raw.theme : raw
  if (!candidate || typeof candidate !== 'object') return { ok: false, error: 'No theme payload' }

  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return { ok: false, error: 'Missing id' }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return { ok: false, error: 'Missing name' }

  const seedKeys: Array<keyof ThemeSeeds> = [
    'accent', 'accentAlt', 'bg', 'surface', 'border', 'text', 'textDim', 'success', 'warning', 'danger',
  ]
  for (const mode of ['dark', 'light'] as const) {
    const seeds = candidate[mode]
    if (!seeds || typeof seeds !== 'object') return { ok: false, error: `Missing "${mode}" seeds` }
    for (const k of seedKeys) {
      if (typeof seeds[k] !== 'string' || !seeds[k].trim()) {
        return { ok: false, error: `Missing ${mode}.${String(k)}` }
      }
    }
  }

  return { ok: true, theme: candidate as Theme }
}
