import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { REPO_ROOT } from './contract'

/** Repo-relative paths of every source file under `dir`, POSIX-separated. */
export function sourcesUnder(dir: string, extensions = ['.ts', '.tsx']): string[] {
  const out: string[] = []
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry.endsWith('.d.ts')) continue
      if (extensions.some((e) => entry.endsWith(e))) {
        out.push(relative(REPO_ROOT, full).split(sep).join('/'))
      }
    }
  }
  walk(join(REPO_ROOT, dir))
  return out.sort()
}

export const rendererSources = () => sourcesUnder('src/renderer')
export const mainSources = () => sourcesUnder('src/main')
export const sharedSources = () => sourcesUnder('src/shared')

/** Every first-party TypeScript source, renderer and node side alike. */
export function allSources(): string[] {
  return [...rendererSources(), ...mainSources(), ...sharedSources(), 'sidecar/index.ts']
}

export const readSource = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')
