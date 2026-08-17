/**
 * Built-in themes.
 *
 * Each is authored as ten seeds per mode plus effects, typography and
 * branding; the ~78 runtime tokens are derived from these (see theme-derive.ts).
 *
 * The default reproduces the original OpenClaw palette exactly — the anchors
 * glow 0.6 / radius 20 / blur 18 make the derivation a no-op against the
 * previously hardcoded values.
 *
 * Preset names are original. Style them after whatever you like in the editor;
 * the names only matter if you redistribute the app.
 */
import type { Theme } from './types'

export const DEFAULT_THEME_ID = 'openclaw'

export const BUILT_IN_THEMES: Theme[] = [
  {
    id: 'openclaw',
    name: 'OpenClaw',
    builtIn: true,
    dark: {
      accent: '#e24a4a', accentAlt: '#d97757',
      bg: '#242422', surface: '#353530', border: '#3b3b36',
      text: '#ccc9c0', textDim: '#c0bdb2',
      success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
    },
    light: {
      accent: '#e24a4a', accentAlt: '#d97757',
      bg: '#f9f8f5', surface: '#edeae0', border: '#dddad2',
      text: '#3c3929', textDim: '#5a5749',
      success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
    },
    effects: { radius: 20, glow: 0.6, blur: 18 },
    typography: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    branding: {
      appName: 'OpenClaw',
      assistantName: 'OpenClaw',
      tagline: 'Desktop interface for OpenClaw CLI',
      greeting: 'Choose a folder to get started',
      inputPlaceholder: 'Ask OpenClaw anything...',
      glyph: '🦞',
    },
    // Pinned so the shipped look is reproduced byte-for-byte. These are
    // hand-tuned values the generic derivation cannot reach from seeds alone —
    // e.g. the muted sage/terracotta status colours, and stopBg vs statusError
    // being two deliberately different reds.
    overrides: {
      dark: {
              "containerBgCollapsed": "#21211e",
              "surfaceSecondary": "#42423d",
              "inputPillBg": "#2a2a27",
              "textTertiary": "#76766e",
              "textMuted": "#353530",
              "statusIdle": "#8a8a80",
              "statusComplete": "#7aac8c",
              "statusCompleteBg": "rgba(122, 172, 140, 0.1)",
              "statusError": "#c47060",
              "statusErrorBg": "rgba(196, 112, 96, 0.08)",
              "statusDead": "#c47060",
              "tabActiveBorder": "#4a4a45",
              "userBubbleBorder": "#4a4a45",
              "toolBorder": "#4a4a45",
              "timelineLine": "#353530",
              "stopHover": "#dc2626",
              "sendHover": "#cd3f3f",
              "popoverBg": "#292927",
              "micDisabled": "#42423d",
              "placeholder": "#6b6b60",
              "btnDisabled": "#42423d",
              "btnHoverBg": "#302f2d",
              "permissionDeniedBorder": "rgba(196, 112, 96, 0.3)",
              "permissionDeniedHeaderBorder": "rgba(196, 112, 96, 0.12)"
      },
      light: {
              "containerBgCollapsed": "#f4f2ed",
              "surfaceSecondary": "#dddad2",
              "inputPillBg": "#ffffff",
              "textTertiary": "#8a8a80",
              "textMuted": "#dddad2",
              "statusIdle": "#8a8a80",
              "statusComplete": "#5a9e6f",
              "statusCompleteBg": "rgba(90, 158, 111, 0.1)",
              "statusError": "#c47060",
              "statusErrorBg": "rgba(196, 112, 96, 0.06)",
              "statusDead": "#c47060",
              "timelineLine": "#dddad2",
              "stopHover": "#dc2626",
              "sendHover": "#cd3f3f",
              "codeBg": "#f0eee8",
              "placeholder": "#b0ada4",
              "permissionDeniedBorder": "rgba(196, 112, 96, 0.3)",
              "permissionDeniedHeaderBorder": "rgba(196, 112, 96, 0.12)"
      },
    },
  },
  {
    id: "coreglass",
    name: "Coreglass",
    builtIn: true,
    dark: {
      "accent": "#2FD9F5",
      "accentAlt": "#FFB026",
      "bg": "#0A1017",
      "surface": "#141F2B",
      "border": "#26394D",
      "text": "#E6F4FB",
      "textDim": "#93AABC",
      "success": "#3FDCA0",
      "warning": "#FFC13D",
      "danger": "#FF5C5C"
    },
    light: {
      "accent": "#077387",
      "accentAlt": "#8F5B00",
      "bg": "#F2F7FB",
      "surface": "#E4EDF5",
      "border": "#BFD2E0",
      "text": "#0B1A26",
      "textDim": "#465E70",
      "success": "#0B7148",
      "warning": "#8A5A00",
      "danger": "#BE2430"
    },
    effects: {
      "radius": 6,
      "glow": 0.85,
      "blur": 18
    },
    typography: {
      "sans": "\"Bahnschrift\", \"Segoe UI Variable Text\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", Arial, sans-serif",
      "mono": "\"Cascadia Mono\", \"Consolas\", \"SF Mono\", \"Menlo\", \"DejaVu Sans Mono\", ui-monospace, monospace"
    },
    branding: {
      "appName": "Coreglass",
      "assistantName": "Vector",
      "tagline": "Machined intelligence, projected on glass.",
      "greeting": "All systems nominal. Standing by for your directive.",
      "inputPlaceholder": "Issue a directive to Vector...",
      "glyph": "◈"
    },
  },
  {
    id: "halcyon-lattice",
    name: "Halcyon Lattice",
    builtIn: true,
    dark: {
      "accent": "#8FA7FF",
      "accentAlt": "#67E8F9",
      "bg": "#0C1026",
      "surface": "#161B33",
      "border": "#27305A",
      "text": "#E4E9FF",
      "textDim": "#97A2CC",
      "success": "#6EE7B7",
      "warning": "#FCD34D",
      "danger": "#FF7A93"
    },
    light: {
      "accent": "#4C5FD7",
      "accentAlt": "#0E7490",
      "bg": "#F5F7FF",
      "surface": "#ECF0FF",
      "border": "#D3DAF5",
      "text": "#1B2145",
      "textDim": "#5A6494",
      "success": "#0D7C55",
      "warning": "#8F5A05",
      "danger": "#BE2E48"
    },
    effects: {
      "radius": 18,
      "glow": 0.55,
      "blur": 22
    },
    typography: {
      "sans": "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif",
      "mono": "'Cascadia Code', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace"
    },
    branding: {
      "appName": "Halcyon",
      "assistantName": "Halcyon",
      "tagline": "A quiet intelligence, held in light.",
      "greeting": "Lattice is calm. What are we looking at?",
      "inputPlaceholder": "Ask Halcyon anything...",
      "glyph": "◈"
    },
  },
  {
    id: "cathode-glow",
    name: "Cathode Glow",
    builtIn: true,
    dark: {
      "accent": "#3BE86B",
      "accentAlt": "#FFB454",
      "bg": "#070A07",
      "surface": "#0E140D",
      "border": "#1D2A1B",
      "text": "#A9E6A0",
      "textDim": "#6E9E68",
      "success": "#2FD98A",
      "warning": "#FF8A1F",
      "danger": "#FF5545"
    },
    light: {
      "accent": "#0E7A32",
      "accentAlt": "#8F5A00",
      "bg": "#F2F5EF",
      "surface": "#E4EBDF",
      "border": "#C6D2C0",
      "text": "#0F2A16",
      "textDim": "#3F6A45",
      "success": "#0B6B48",
      "warning": "#A34500",
      "danger": "#B3261E"
    },
    effects: {
      "radius": 3,
      "glow": 0.45,
      "blur": 4
    },
    typography: {
      "sans": "Consolas, 'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
      "mono": "'Cascadia Mono', Consolas, 'SF Mono', Monaco, Menlo, 'Courier New', monospace"
    },
    branding: {
      "appName": "Cathode",
      "assistantName": "CATHODE",
      "tagline": "Slow phosphor, fast answers.",
      "greeting": "SYSTEM READY. AWAITING INPUT_",
      "inputPlaceholder": "> enter query_",
      "glyph": ">_"
    },
  },
  {
    id: "neon-horizon",
    name: "Neon Horizon",
    builtIn: true,
    dark: {
      "accent": "#ff2fb9",
      "accentAlt": "#22e0ff",
      "bg": "#150a2b",
      "surface": "#221040",
      "border": "#3a1f63",
      "text": "#e8e2f5",
      "textDim": "#a99cc4",
      "success": "#2ee6a8",
      "warning": "#ffb340",
      "danger": "#ff4d6d"
    },
    light: {
      "accent": "#c2006e",
      "accentAlt": "#0e7490",
      "bg": "#faf7ff",
      "surface": "#f1ecfb",
      "border": "#ded3f0",
      "text": "#251b38",
      "textDim": "#5c5175",
      "success": "#0b7a53",
      "warning": "#a15c00",
      "danger": "#c81e4a"
    },
    effects: {
      "radius": 18,
      "glow": 0.82,
      "blur": 22
    },
    typography: {
      "sans": "\"Avenir Next\", \"Segoe UI Variable Text\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", Arial, sans-serif",
      "mono": "\"Cascadia Mono\", \"SF Mono\", Menlo, Consolas, \"Courier New\", monospace"
    },
    branding: {
      "appName": "Neon Horizon",
      "assistantName": "VECTRA",
      "tagline": "Chrome logic on an endless grid.",
      "greeting": "Engine's warm. Where are we headed?",
      "inputPlaceholder": "Set a heading for VECTRA...",
      "glyph": "🌇"
    },
  },
]

export function findBuiltIn(id: string): Theme | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id)
}
