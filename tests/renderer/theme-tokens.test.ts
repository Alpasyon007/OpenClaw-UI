import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getColors } from '../../src/renderer/theme'
import { derivePalette } from '../../src/renderer/theme-derive'
import { BUILT_IN_THEMES } from '../../src/renderer/theme-presets'
import { REPO_ROOT } from '../helpers/contract'
import { rendererSources } from '../helpers/sources'

/**
 * Colour tokens are read off a plain object with no index signature, so
 * `colors.doesNotExist` is a compile error — but only if `npm run typecheck`
 * is actually green, and it drifts. At runtime the miss is invisible: React
 * receives `style={{ background: undefined }}` and simply paints nothing.
 *
 * These tests close that gap from the other side, by checking every token a
 * component reads against every palette the app can produce.
 */

const dark = getColors(true)
const light = getColors(false)

describe('palette shape', () => {
  it('defines the same tokens in dark and light', () => {
    const inDarkOnly = Object.keys(dark).filter((k) => !(k in light))
    const inLightOnly = Object.keys(light).filter((k) => !(k in dark))
    expect({ inDarkOnly, inLightOnly }).toEqual({ inDarkOnly: [], inLightOnly: [] })
  })

  it('gives every token a non-empty string value', () => {
    for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
      const empty = Object.entries(palette)
        .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
        .map(([k]) => `${name}.${k}`)
      expect(empty).toEqual([])
    }
  })

  it('emits no undefined, NaN or unresolved values', () => {
    for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
      const broken = Object.entries(palette)
        .filter(([, v]) => /undefined|NaN|null/.test(String(v)))
        .map(([k, v]) => `${name}.${k} = ${v}`)
      expect(broken).toEqual([])
    }
  })
})

describe('every built-in theme derives a complete palette', () => {
  const baseline = new Set(Object.keys(dark))

  for (const theme of BUILT_IN_THEMES) {
    for (const isDark of [true, false]) {
      it(`${theme.id} (${isDark ? 'dark' : 'light'})`, () => {
        const derived = derivePalette(
          isDark ? theme.dark : theme.light,
          theme.effects,
          isDark,
        )
        const missing = [...baseline].filter((k) => !(k in derived))
        const broken = Object.entries(derived)
          .filter(([, v]) => typeof v !== 'string' || v.trim() === '' || /undefined|NaN/.test(String(v)))
          .map(([k, v]) => `${k} = ${v}`)
        expect({ missing, broken }).toEqual({ missing: [], broken: [] })
      })
    }
  }
})

describe('tokens referenced by components', () => {
  /**
   * Collects every `colors.foo` read across the renderer. Only the unambiguous
   * receiver name is scanned: single-letter aliases like `c` are also used for
   * command objects and string callbacks, and folding those in produces noise
   * that trains people to ignore this test.
   *
   * theme-derive.ts is excluded because it *builds* the palette — its local
   * `colors` is an RGB triple, not a token bag.
   */
  const used = new Map<string, string[]>()
  for (const file of rendererSources()) {
    if (file.endsWith('theme-derive.ts')) continue
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    for (const line of src.split('\n')) {
      // Prose about a token is not a read of it — comments routinely name a
      // token precisely because it was wrong.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const m of line.matchAll(/\bcolors\.([a-zA-Z_][\w]*)\b/g)) {
        used.set(m[1], [...(used.get(m[1]) ?? []), file])
      }
    }
  }

  it('reads a meaningful number of tokens', () => {
    expect(used.size).toBeGreaterThan(20)
  })

  it('resolves every referenced token against the palette', () => {
    const unresolved = [...used]
      .filter(([token]) => !(token in dark))
      .map(([token, files]) => `colors.${token} — read in ${[...new Set(files)].join(', ')}`)

    expect(unresolved).toEqual([])
  })
})
