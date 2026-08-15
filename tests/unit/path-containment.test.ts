import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSource } from '../helpers/sources'

/**
 * Path containment on Windows.
 *
 * `assertSkillDirContained` compared a resolved path against `base + '/'`. On
 * Windows `resolve()` returns backslash-separated paths, so the prefix never
 * matched and *every* skill install and uninstall threw "Path escapes skills
 * directory" before touching the disk — the guard rejected the very paths it
 * exists to permit.
 *
 * The function is module-private, so this pins the invariant two ways: the
 * containment logic itself, and a source-level check that no separator is
 * hardcoded anywhere a path is compared.
 */

/** The corrected predicate, mirrored from src/main/marketplace/catalog.ts. */
function contained(candidate: string, base: string): boolean {
  const resolved = resolve(candidate)
  const root = resolve(base)
  return resolved === root || resolved.startsWith(root + sep)
}

describe('skill directory containment', () => {
  const base = join(homedir(), '.claude', 'skills')

  it('accepts the base directory itself', () => {
    expect(contained(base, base)).toBe(true)
  })

  it('accepts a direct child, whichever separator the platform uses', () => {
    expect(contained(join(base, 'skill-creator'), base)).toBe(true)
  })

  it('accepts a nested child', () => {
    expect(contained(join(base, 'a', 'b'), base)).toBe(true)
  })

  it('rejects a parent-directory escape', () => {
    expect(contained(join(base, '..', 'evil'), base)).toBe(false)
  })

  it('rejects an unrelated absolute path', () => {
    expect(contained(resolve(sep, 'tmp', 'evil'), base)).toBe(false)
  })

  it('rejects a sibling whose name merely starts with the base name', () => {
    // `.../skills-evil` shares a string prefix with `.../skills` but is not
    // inside it; the separator in the comparison is what rules it out.
    expect(contained(`${base}-evil`, base)).toBe(false)
  })
})

describe('no hardcoded separators in path guards', () => {
  it('catalog.ts compares paths with sep, not a literal slash', () => {
    const src = readSource('src/main/marketplace/catalog.ts')
    const offenders = src
      .split('\n')
      .map((line, i) => [line, i + 1] as const)
      .filter(([line]) => /startsWith\([^)]*\+\s*['"][/\\]['"]/.test(line))
      .map(([line, n]) => `catalog.ts:${n} — ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})
