/**
 * Colour input handling for the theme editor.
 *
 * A hex field on a phone is typed one character at a time, which means it is
 * invalid far more often than it is valid — `#`, `#e`, `#e2`, `#e24` are all
 * states the user passes through on the way to a colour. Treating those as
 * errors makes the field flash red on every keystroke; treating them as "not
 * yet a colour" and leaving the last good value in the preview is what makes
 * the field usable.
 */

/** A complete 3- or 6-digit hex colour. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHex(value: string): boolean {
  return HEX.test(value.trim())
}

/**
 * Coerce user input toward a hex colour without fighting the typist.
 *
 * Adds the leading `#` (nobody types it), drops anything that is not a hex
 * digit, and caps the length. Deliberately does *not* reject a partial value —
 * see the module note.
 */
export function normaliseHexInput(value: string): string {
  const digits = value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
  return `#${digits.toLowerCase()}`
}

/** Expand `#abc` to `#aabbcc`, so downstream code sees one form. */
export function expandHex(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!HEX.test(trimmed)) return trimmed
  if (trimmed.length === 7) return trimmed
  const [, r, g, b] = trimmed
  return `#${r}${r}${g}${g}${b}${b}`
}

/**
 * Whether text on this colour should be light or dark.
 *
 * Relative luminance with the sRGB coefficients, not a naive average: the eye
 * is roughly six times more sensitive to green than to blue, and an average
 * puts white text on saturated greens where it is unreadable.
 */
export function isLight(hex: string): boolean {
  const value = expandHex(hex)
  if (!HEX.test(value)) return false
  const r = parseInt(value.slice(1, 3), 16) / 255
  const g = parseInt(value.slice(3, 5), 16) / 255
  const b = parseInt(value.slice(5, 7), 16) / 255
  const channel = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  return luminance > 0.45
}

/**
 * A stable, filesystem- and URL-safe id from a theme name.
 *
 * Suffixed with a caller-supplied discriminator rather than a random value so
 * the same name does not silently produce two themes that look identical in the
 * list.
 */
export function themeIdFrom(name: string, discriminator: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'theme'
  return `custom-${slug}-${discriminator}`
}
