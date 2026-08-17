/**
 * Theme derivation — ThemeSeeds + ThemeEffects -> the full ColorPalette.
 *
 * Authoring 78 tokens by hand is not realistic, so a theme is authored from ten
 * seeds and everything else is derived. Pure TypeScript, no dependencies.
 *
 * Every value is defensive: seeds come from a user-editable editor, so bad
 * input falls back to something coherent rather than throwing or producing
 * `NaN` in a CSS string.
 *
 * Anchors: effects.glow = 0.6 with radius = 20 / blur = 18 reproduces the
 * original OpenClaw palette exactly, so the default preset is a no-op.
 */
import type { ThemeSeeds, ThemeEffects } from './types'
import type { ColorPalette } from './palettes'

// ─── colour primitives ───

interface RGB { r: number; g: number; b: number }

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)
const num = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : fallback
const byte = (n: number): number => Math.round(clamp(n, 0, 255))
const a3 = (n: number): number => Math.round(clamp(n, 0, 1) * 1000) / 1000

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
}

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / a few names. Alpha is ignored. */
function parseColor(input: unknown): RGB | null {
  if (typeof input !== 'string') return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (NAMED[s]) s = NAMED[s]
  if (s.charAt(0) === '#') {
    const h = s.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    if (h.length === 3 || h.length === 4) {
      return {
        r: parseInt(h.charAt(0) + h.charAt(0), 16),
        g: parseInt(h.charAt(1) + h.charAt(1), 16),
        b: parseInt(h.charAt(2) + h.charAt(2), 16),
      }
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      }
    }
    return null
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const chan = (p: string): number => {
      const v = parseFloat(p)
      if (!Number.isFinite(v)) return NaN
      return p.indexOf('%') >= 0 ? (v / 100) * 255 : v
    }
    const r = chan(parts[0]), g = chan(parts[1]), b = chan(parts[2])
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
    return { r: byte(r), g: byte(g), b: byte(b) }
  }
  return null
}

/** Parse with a guaranteed result. */
function safeColor(input: unknown, fallback: string): RGB {
  return parseColor(input) ?? parseColor(fallback) ?? { r: 128, g: 128, b: 128 }
}

function toHex(c: RGB): string {
  const h = (n: number): string => byte(n).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** rgba() string from an RGB + alpha 0..1 */
function rgba(c: RGB, alpha: number): string {
  return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${a3(num(alpha, 1))})`
}

/** Linear blend: t=0 -> a, t=1 -> b */
function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp(num(t, 0), 0, 1)
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k }
}

const WHITE: RGB = { r: 255, g: 255, b: 255 }
const BLACK: RGB = { r: 0, g: 0, b: 0 }

const lighten = (c: RGB, t: number): RGB => mix(c, WHITE, t)
const darken = (c: RGB, t: number): RGB => mix(c, BLACK, t)

/** WCAG relative luminance */
function luminance(c: RGB): number {
  const ch = (v: number): number => {
    const s = clamp(v, 0, 255) / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** WCAG contrast ratio, 1..21 */
function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Push `fg` away from `bg` (toward white on a dark bg, toward black on a light
 * bg) until the contrast target is met. Returns the original colour untouched
 * when it already passes. `onFix` is called once if an adjustment happened.
 */
function ensureContrast(
  fg: RGB,
  bg: RGB,
  target: number,
  onFix?: (from: string, to: string, before: number, after: number) => void,
): RGB {
  const before = contrast(fg, bg)
  if (before >= target) return fg
  const toward = luminance(bg) < 0.5 ? WHITE : BLACK
  let out = fg
  for (let i = 1; i <= 40; i++) {
    out = mix(fg, toward, i / 40)
    if (contrast(out, bg) >= target) break
  }
  if (onFix) onFix(toHex(fg), toHex(out), Math.round(before * 100) / 100, Math.round(contrast(out, bg) * 100) / 100)
  return out
}
/**
 * Derive the full runtime palette from seeds + effects.
 *
 * @param seeds     per-mode seed colours (theme.dark or theme.light)
 * @param effects   radius / glow / blur
 * @param isDark    which mode we are rendering
 * @param overrides optional hand-pinned token values, applied last
 * @param report    optional sink for legibility adjustments (see contrastNotes)
 */
export function derivePalette(
  seeds: ThemeSeeds,
  effects: ThemeEffects,
  isDark: boolean,
  overrides?: Partial<ColorPalette>,
  report?: string[],
): ColorPalette {
  const s = (seeds || {}) as Partial<ThemeSeeds>
  const fx = (effects || {}) as Partial<ThemeEffects>

  // ── 1. resolve seeds ─────────────────────────────────────────────────────
  // A missing/invalid seed never throws. Where possible it is reconstructed
  // from a seed that *did* parse, so a half-filled theme still looks coherent
  // instead of snapping back to unrelated OpenClaw browns.
  const bg = safeColor(s.bg, isDark ? '#242422' : '#f9f8f5')
  /** true when the resolved background is dark, regardless of the isDark flag */
  const darkBg = luminance(bg) < 0.4
  const away = (c: RGB, t: number): RGB => (darkBg ? lighten(c, t) : darken(c, t))

  const surface  = parseColor(s.surface) ?? away(bg, 0.08)
  const border   = parseColor(s.border) ?? away(bg, 0.16)
  const textSeed = parseColor(s.text) ?? away(bg, 0.82)
  const dimSeed  = parseColor(s.textDim) ?? mix(textSeed, bg, 0.16)
  const accent   = safeColor(s.accent, '#e24a4a')
  // an unparseable accentAlt falls back to the accent itself, never to a stale brand hue
  const accentAlt = parseColor(s.accentAlt) ?? accent
  const success   = safeColor(s.success, '#22c55e')
  const warning   = safeColor(s.warning, '#f59e0b')
  const danger    = safeColor(s.danger, '#ef4444')

  // ── 2. effects → scalar multipliers ──────────────────────────────────────
  const glow = clamp(num(fx.glow, 0.6), 0, 1)
  const blurPx = clamp(num(fx.blur, 18), 0, 64)
  const radius = clamp(num(fx.radius, 20), 0, 64)

  // Anchored so glow = 0.6 reproduces the shipped OpenClaw alphas exactly:
  // 0.55 + 0.75*0.6 = 1.0
  const glowScale = 0.55 + 0.75 * glow
  /** glow-scaled alpha */
  const G = (base: number): number => a3(clamp(base * glowScale, 0, 1))
  /** larger radius / blur → softer, wider shadows. radius 20 + blur 18 → 1.0 (shipped) */
  const soft = clamp(0.6 + radius / 100 + blurPx / 90, 0.6, 1.8)
  const px = (n: number): number => Math.round(n * soft)
  /**
   * Accent bloom ring appended to elevation shadows. Only kicks in above the
   * 0.6 anchor, so a default theme keeps plain neutral shadows and a
   * high-glow theme gets a halo.
   */
  const bloom = (spread: number, base: number): string => {
    if (glow <= 0.62) return ''
    const a = ((glow - 0.6) / 0.4) * base
    return `, 0 0 ${Math.round(spread * soft)}px ${rgba(accent, a3(a))}`
  }

  // ── 3. neutral scaffolding ───────────────────────────────────────────────
  /** white wash on dark, black wash on light */
  const wash = (alpha: number): string => rgba(darkBg ? WHITE : BLACK, alpha)
  const shadowInk = (alpha: number): string => rgba(BLACK, alpha)

  const containerBg = bg
  const textPrimary = ensureContrast(textSeed, containerBg, 4.5, (from, to, b4, af) =>
    report?.push(`textPrimary ${from} vs containerBg ${toHex(containerBg)} was ${b4}:1 → raised to ${to} (${af}:1)`),
  )
  const textSecondary = ensureContrast(dimSeed, containerBg, 3.5, (from, to, b4, af) =>
    report?.push(`textSecondary ${from} vs containerBg ${toHex(containerBg)} was ${b4}:1 → raised to ${to} (${af}:1)`),
  )
  const textTertiary = ensureContrast(
    mix(textSecondary, bg, darkBg ? 0.47 : 0.3),
    containerBg,
    2.6,
    (from, to, b4, af) => report?.push(`textTertiary ${from} was ${b4}:1 → ${to} (${af}:1)`),
  )
  const placeholderC = ensureContrast(mix(textSecondary, bg, 0.54), containerBg, 2.0, (from, to, b4, af) =>
    report?.push(`placeholder ${from} was ${b4}:1 → ${to} (${af}:1)`),
  )
  const idle = mix(textSecondary, bg, darkBg ? 0.35 : 0.3)

  /** deeper than bg: toward black on dark, toward ink on light */
  const deepen = (t: number): RGB => mix(bg, darkBg ? BLACK : textPrimary, t)

  /** border on a *raised* surface reads lighter than the container hairline in dark mode */
  const elevatedBorder = darkBg ? mix(surface, textPrimary, 0.14) : border
  const surfaceSecondary = mix(surface, textPrimary, 0.09)
  /** faint divider / disabled fill sitting just off the background */
  const muted = mix(bg, textPrimary, darkBg ? 0.1 : 0.15)
  const disabledTone = darkBg ? surfaceSecondary : mix(border, textPrimary, 0.13)

  /**
   * Status dots: only tone a seed down if it is *over*-saturated for a small
   * 8px dot. An already-muted seed (sage green, terracotta red) is left alone,
   * so authors never get double-muted colours.
   */
  const calm = (c: RGB): RGB => {
    const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255
    return mix(c, idle, clamp((chroma - 0.45) * 1.6, 0, 0.45))
  }
  const dangerMuted = ensureContrast(calm(danger), containerBg, 3)
  const successDot = ensureContrast(calm(success), containerBg, 3)

  /**
   * Foreground for filled accent buttons. White reads best on mid/dark accents;
   * a light accent (neon cyan, amber) needs ink. Target is 3:1 — AA for the
   * large/bold text and UI components these fills carry.
   */
  const ink = darken(bg, darkBg ? 0.86 : 0.9)
  const preferInk = luminance(accent) > 0.45
  let onAccent = preferInk ? ink : WHITE
  if (contrast(onAccent, accent) < 3) {
    const alt = preferInk ? WHITE : ink
    if (contrast(alt, accent) > contrast(onAccent, accent)) onAccent = alt
  }
  const textOnAccent = ensureContrast(onAccent, accent, 3, (from, to, b4, af) =>
    report?.push(`textOnAccent ${from} vs accent ${toHex(accent)} was ${b4}:1 → ${to} (${af}:1)`),
  )

  // ── 4. the 78 tokens ─────────────────────────────────────────────────────
  const out: Record<string, string> = {
    // Container (glass surfaces)
    containerBg: toHex(containerBg),
    containerBgCollapsed: toHex(deepen(darkBg ? 0.09 : 0.035)),
    containerBorder: toHex(border),
    containerShadow:
      `0 ${px(8)}px ${px(28)}px ${shadowInk(darkBg ? 0.35 : 0.08)}, ` +
      `0 1px ${px(6)}px ${shadowInk(darkBg ? 0.25 : 0.04)}` +
      bloom(26, 0.14),
    cardShadow: `0 2px ${px(8)}px ${shadowInk(darkBg ? 0.35 : 0.06)}` + bloom(14, 0.08),
    cardShadowCollapsed: `0 2px ${px(6)}px ${shadowInk(darkBg ? 0.4 : 0.08)}`,

    // Surface layers
    surfacePrimary: toHex(surface),
    surfaceSecondary: toHex(surfaceSecondary),
    surfaceHover: wash(darkBg ? 0.05 : 0.04),
    surfaceActive: wash(darkBg ? 0.08 : 0.06),

    // Input
    inputBg: 'transparent',
    inputBorder: toHex(border),
    inputFocusBorder: rgba(accentAlt, G(0.4)),
    inputPillBg: toHex(darkBg ? mix(bg, surface, 0.4) : lighten(bg, 0.85)),

    // Text
    textPrimary: toHex(textPrimary),
    textSecondary: toHex(textSecondary),
    textTertiary: toHex(textTertiary),
    textMuted: toHex(muted),

    // Accent
    accent: toHex(accent),
    accentLight: rgba(accent, G(0.12)),
    accentSoft: rgba(accent, G(darkBg ? 0.18 : 0.15)),

    // Status dots
    statusIdle: toHex(idle),
    statusRunning: toHex(accent),
    statusRunningBg: rgba(accent, G(0.12)),
    statusComplete: toHex(successDot),
    statusCompleteBg: rgba(successDot, G(0.1)),
    statusError: toHex(dangerMuted),
    statusErrorBg: rgba(dangerMuted, G(darkBg ? 0.08 : 0.06)),
    statusDead: toHex(dangerMuted),
    statusPermission: toHex(accent),
    statusPermissionGlow: rgba(accent, G(darkBg ? 0.4 : 0.3)),

    // Tab
    tabActive: toHex(surface),
    tabActiveBorder: toHex(elevatedBorder),
    tabInactive: 'transparent',
    tabHover: wash(darkBg ? 0.05 : 0.04),

    // User message bubble
    userBubble: toHex(surface),
    userBubbleBorder: toHex(elevatedBorder),
    userBubbleText: toHex(textPrimary),

    // Tool card
    toolBg: toHex(surface),
    toolBorder: toHex(elevatedBorder),
    toolRunningBorder: rgba(accentAlt, G(0.3)),
    toolRunningBg: rgba(accentAlt, G(0.05)),

    // Timeline
    timelineLine: toHex(muted),
    timelineNode: rgba(accentAlt, G(0.2)),
    timelineNodeActive: toHex(accentAlt),

    // Scrollbar
    scrollThumb: wash(darkBg ? 0.15 : 0.1),
    scrollThumbHover: wash(darkBg ? 0.25 : 0.18),

    // Stop button
    stopBg: toHex(danger),
    stopHover: toHex(darkBg ? darken(danger, 0.12) : darken(danger, 0.14)),

    // Send button
    sendBg: toHex(accent),
    sendHover: toHex(darkBg ? darken(accent, 0.1) : darken(accent, 0.12)),
    sendDisabled: rgba(accent, 0.3),

    // Popover
    popoverBg: toHex(darkBg ? mix(bg, surface, 0.3) : bg),
    popoverBorder: toHex(border),
    popoverShadow:
      `0 ${px(4)}px ${px(20)}px ${shadowInk(darkBg ? 0.3 : 0.1)}, ` +
      `0 1px ${px(4)}px ${shadowInk(darkBg ? 0.2 : 0.06)}` +
      bloom(18, 0.1),

    // Code block
    codeBg: toHex(deepen(darkBg ? 0.28 : 0.05)),

    // Mic button
    micBg: toHex(surface),
    micColor: toHex(textSecondary),
    micDisabled: toHex(disabledTone),

    // Placeholder
    placeholder: toHex(placeholderC),

    // Disabled button colour
    btnDisabled: toHex(disabledTone),

    // Text on accent backgrounds
    textOnAccent: toHex(textOnAccent),

    // Button hover (CSS-only stack buttons)
    btnHoverColor: toHex(darkBg ? textSecondary : textPrimary),
    btnHoverBg: toHex(darkBg ? mix(bg, surface, 0.7) : surface),

    // Accent border variants
    accentBorder: rgba(accent, G(0.2)),
    accentBorderMedium: rgba(accent, G(0.28)),

    // Permission card (warning)
    permissionBorder: rgba(warning, G(0.3)),
    permissionShadow: `0 2px ${px(12)}px ${rgba(warning, G(0.08))}`,
    permissionHeaderBg: rgba(warning, G(0.06)),
    permissionHeaderBorder: rgba(warning, G(0.12)),

    // Permission allow (success)
    permissionAllowBg: rgba(success, 0.1),
    permissionAllowHoverBg: rgba(success, 0.22),
    permissionAllowBorder: rgba(success, 0.25),

    // Permission deny (danger)
    permissionDenyBg: rgba(danger, 0.08),
    permissionDenyHoverBg: rgba(danger, 0.18),
    permissionDenyBorder: rgba(danger, 0.22),

    // Permission denied card
    permissionDeniedBorder: rgba(dangerMuted, 0.3),
    permissionDeniedHeaderBorder: rgba(dangerMuted, 0.12),
  }

  if (overrides) {
    for (const k of Object.keys(overrides) as Array<keyof ColorPalette>) {
      const v = overrides[k]
      if (typeof v === 'string' && v.trim()) out[k as string] = v
    }
  }
  return out as unknown as ColorPalette
}
