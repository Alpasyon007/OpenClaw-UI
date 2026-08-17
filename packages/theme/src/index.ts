/**
 * `@openclaw/theme` — one theme system for desktop and phone.
 *
 * Pure: no DOM, no React, no storage. A theme is authored from ten seeds and
 * the ~68 runtime tokens are derived, so both surfaces render identical colour
 * from identical input instead of drifting apart as one gets restyled.
 */
export * from './types'
export * from './palettes'
export * from './derive'
export * from './presets'
