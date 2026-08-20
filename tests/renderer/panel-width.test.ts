/**
 * Panel width resolution.
 *
 * The bug these pin: the panel was clamped against the *screen* while the
 * constraint that matters is the *window*. On a 1920 display the launcher's
 * client area is 1200px, but `maxPanelWidthFor(1920)` returned 1860 — so
 * Appearance offered widths the window could never show, and the renderer laid
 * the card out past the right edge where it was clipped rather than scrolled.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STANDARD_WIDTH,
  PANEL_WIDTH_MIN,
  PANEL_WINDOW_MARGIN,
  clampPanelWidth,
  maxPanelWidthFor,
  resolveWidth,
  sanitizeWidthSetting,
} from '../../src/renderer/theme'

describe('maxPanelWidthFor', () => {
  it('uses the window ceiling when the shell has measured one', () => {
    expect(maxPanelWidthFor(1920, 1200)).toBe(1200 - PANEL_WINDOW_MARGIN)
  })

  it('falls back to the screen before any measurement arrives', () => {
    expect(maxPanelWidthFor(1920)).toBe(1920 - PANEL_WINDOW_MARGIN)
  })

  it('never returns less than the minimum panel', () => {
    expect(maxPanelWidthFor(200, 200)).toBe(PANEL_WIDTH_MIN)
  })

  it('ignores a nonsense ceiling rather than collapsing to it', () => {
    expect(maxPanelWidthFor(1920, 0)).toBe(1920 - PANEL_WINDOW_MARGIN)
    expect(maxPanelWidthFor(1920, Number.NaN)).toBe(1920 - PANEL_WINDOW_MARGIN)
  })

  it('substitutes a sane screen width for a nonsense one', () => {
    expect(maxPanelWidthFor(0)).toBe(1440 - PANEL_WINDOW_MARGIN)
  })
})

describe('resolveWidth', () => {
  it('passes a pixel setting through when it fits', () => {
    expect(resolveWidth({ unit: 'px', value: 460 }, 1920, 1200)).toBe(460)
  })

  it('caps a pixel setting at what the window can show', () => {
    // The regression: 1800 was accepted and then clipped at 1200.
    expect(resolveWidth({ unit: 'px', value: 1800 }, 1920, 1200)).toBe(1200 - PANEL_WINDOW_MARGIN)
  })

  it('resolves a percentage against the screen, then caps it to the window', () => {
    // 50% of a 3440 ultrawide is 1720px on a window that tops out at 1200.
    expect(resolveWidth({ unit: 'percent', value: 50 }, 3440, 1200)).toBe(1200 - PANEL_WINDOW_MARGIN)
    // The same percentage fits once the window is allowed to grow.
    expect(resolveWidth({ unit: 'percent', value: 50 }, 3440, 3400)).toBe(1720)
  })

  it('floors at the minimum panel width', () => {
    expect(resolveWidth({ unit: 'px', value: 10 }, 1920, 1200)).toBe(PANEL_WIDTH_MIN)
    expect(resolveWidth({ unit: 'percent', value: 1 }, 1920, 1200)).toBe(PANEL_WIDTH_MIN)
  })
})

describe('clampPanelWidth', () => {
  it('falls back to the default for a non-finite width', () => {
    expect(clampPanelWidth(Number.NaN, 1920, 1200)).toBe(DEFAULT_STANDARD_WIDTH.value)
  })

  it('returns whole pixels', () => {
    expect(Number.isInteger(clampPanelWidth(460.4, 1920, 1200))).toBe(true)
  })
})

describe('sanitizeWidthSetting', () => {
  it('keeps a px setting unclamped, since no display is known at load', () => {
    // Clamping here would bake a boot-time guess into the stored setting;
    // resolveWidth clamps against the real window at render time instead.
    expect(sanitizeWidthSetting({ unit: 'px', value: 4000 }, DEFAULT_STANDARD_WIDTH)).toEqual({
      unit: 'px',
      value: 4000,
    })
  })

  it('bounds a percentage to a usable range', () => {
    expect(sanitizeWidthSetting({ unit: 'percent', value: 999 }, DEFAULT_STANDARD_WIDTH).value).toBe(100)
    expect(sanitizeWidthSetting({ unit: 'percent', value: -5 }, DEFAULT_STANDARD_WIDTH).value).toBe(15)
  })

  it('falls back for junk', () => {
    expect(sanitizeWidthSetting(null, DEFAULT_STANDARD_WIDTH)).toBe(DEFAULT_STANDARD_WIDTH)
    expect(sanitizeWidthSetting({ unit: 'furlongs', value: 3 }, DEFAULT_STANDARD_WIDTH)).toBe(
      DEFAULT_STANDARD_WIDTH,
    )
  })
})
