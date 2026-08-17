/**
 * Palette.
 *
 * Deliberately plain data — the desktop's `theme.ts` derives ~68 tokens and
 * syncs them to CSS custom properties, which has no meaning here. What carries
 * over is the *palette*, so the two surfaces look like one product.
 */
export const colors = {
  bg: '#0b0b10',
  surface: '#16161f',
  surfaceRaised: '#1d1d29',
  border: '#26263a',
  borderStrong: '#34344c',

  text: '#e6e6f0',
  textMuted: '#9898b0',
  textFaint: '#6f6f8a',

  accent: '#c9a227',
  accentText: '#0b0b10',

  ok: '#4ade80',
  warn: '#fbbf24',
  error: '#f87171',
  info: '#7dd3fc',

  userBubble: '#1e2436',
  assistantBubble: '#16161f',
} as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const

export const font = {
  mono: 'monospace',
  size: { xs: 10, sm: 12, md: 14, lg: 16, xl: 20 },
} as const

/** Colour for a run/connection state, so status is consistent everywhere. */
export function statusColor(state: string): string {
  switch (state) {
    case 'ready':
    case 'connected':
    case 'complete':
      return colors.ok
    case 'streaming':
    case 'connecting':
    case 'running':
      return colors.info
    case 'pairing':
      return colors.warn
    case 'error':
    case 'failed':
      return colors.error
    default:
      return colors.textMuted
  }
}
