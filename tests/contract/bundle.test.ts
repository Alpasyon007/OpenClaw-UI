import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../helpers/contract'
import { rendererSources, readSource } from '../helpers/sources'

/**
 * Guards on the shipped renderer bundle.
 *
 * The renderer runs inside a saucer WebView2 window. It has no Node runtime at
 * all — no `process`, no `require`, no `Buffer`. Vite will happily bundle a
 * reference to one of those without complaint, and the failure surfaces only
 * when the code path is first hit, which for a rarely-taken branch can be long
 * after release.
 *
 * The size assertions are a ratchet against accidental weight, not a target.
 */

const DIST = join(REPO_ROOT, 'dist/renderer/assets')

function bundlePath(): string | null {
  if (!existsSync(DIST)) return null
  const js = readdirSync(DIST).filter((f) => f.endsWith('.js'))
  if (js.length === 0) return null
  // The largest .js is the entry chunk.
  return js
    .map((f) => join(DIST, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0]
}

describe('renderer source hygiene', () => {
  /**
   * Source-level check, so it runs without a build. `no-restricted-globals`
   * in ESLint covers the same ground, but a lint rule can be disabled inline
   * and this cannot.
   */
  const NODE_ONLY = [
    { pattern: /\bprocess\.(?!env\b)[a-zA-Z]/, name: 'process.*', note: 'process.env is substituted at build time; nothing else exists' },
    { pattern: /\brequire\s*\(/, name: 'require()', note: 'the renderer bundle is ESM' },
    { pattern: /\b__dirname\b|\b__filename\b/, name: '__dirname/__filename', note: 'CommonJS only' },
    { pattern: /\bfrom\s+'node:/, name: "import from 'node:*'", note: 'no Node builtins in a WebView' },
  ]

  it('never reaches for a Node-only global', () => {
    const offenders: string[] = []
    for (const file of rendererSources()) {
      const src = readSource(file)
      const lines = src.split('\n')
      for (const { pattern, name, note } of NODE_ONLY) {
        lines.forEach((line, i) => {
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
          if (pattern.test(line)) {
            offenders.push(`${file}:${i + 1} uses ${name} — ${note}\n    ${line.trim()}`)
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe.skipIf(!bundlePath())('built renderer bundle', () => {
  const entry = bundlePath()!
  const code = readFileSync(entry, 'utf8')

  it('contains no Node-only global reference', () => {
    const found = ['process.cwd(', 'process.platform', 'process.versions', '__dirname', '__filename']
      .filter((needle) => code.includes(needle))
    expect(found).toEqual([])
  })

  it('stays inside its size budget', () => {
    const raw = Buffer.byteLength(code)
    const gzip = gzipSync(code).byteLength

    // Current: ~846 kB raw / ~244 kB gzip. The ceilings sit a little above
    // that so an ordinary feature lands, but a whole new heavy dependency
    // does not slip in unnoticed. Lower them when code splitting arrives.
    expect(
      { rawKb: Math.round(raw / 1024), gzipKb: Math.round(gzip / 1024) },
      `entry chunk ${entry}`,
    ).toEqual({
      rawKb: expect.any(Number),
      gzipKb: expect.any(Number),
    })
    expect(raw, 'raw entry chunk grew past its budget').toBeLessThan(950 * 1024)
    expect(gzip, 'gzipped entry chunk grew past its budget').toBeLessThan(280 * 1024)
  })

  it('does not inline the notification sound as a data URI', () => {
    // Vite inlines assets under 4 kB. The chime is ~9 kB; if a future change
    // pushes it inline it lands in the parse-blocking entry chunk.
    expect(code).not.toMatch(/data:audio\/mpeg;base64,[A-Za-z0-9+/]{500}/)
  })
})
