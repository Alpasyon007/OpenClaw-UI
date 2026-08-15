#!/usr/bin/env node
/**
 * Fails when a committed generated artefact no longer matches its source.
 *
 * Two files in this repo are generated but *committed*, because the C++ shell
 * loads them directly and has no build step of its own:
 *
 *   shell/web/clui-shim.js   from src/shared/clui-contract.ts via gen-shim.mjs
 *   shell/sidecar/main.cjs   from sidecar/index.ts via esbuild
 *
 * That arrangement works right up until someone edits the contract, runs the
 * app from a dev server where the shim is regenerated on the fly, and commits
 * without regenerating. The shipped build then has a shim that predates the
 * change, and the renderer calls a method that is not there.
 *
 * Regenerating into a scratch directory and diffing is the only honest check:
 * it catches a stale artefact without needing the developer to remember.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'clui-generated-'))

/** Compare ignoring line-ending style — git normalises these on Windows. */
const normalise = (s) => s.replace(/\r\n/g, '\n')

const TARGETS = [
  {
    label: 'clui shim',
    committed: 'shell/web/clui-shim.js',
    regenerate: (out) =>
      execFileSync(
        process.execPath,
        ['sidecar/gen-shim.mjs', 'src/shared/clui-contract.ts', 'src/shared/types.ts', out],
        { cwd: ROOT, stdio: 'pipe' },
      ),
    fix: 'npm run shim',
  },
  {
    label: 'sidecar bundle',
    committed: 'shell/sidecar/main.cjs',
    regenerate: (out) =>
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
          'sidecar/index.ts',
          '--bundle',
          '--platform=node',
          '--format=cjs',
          '--target=node22',
          '--external:node-pty',
          '--minify',
          `--outfile=${out}`,
        ],
        { cwd: ROOT, stdio: 'pipe' },
      ),
    fix: 'npm run sidecar',
  },
]

let failed = false

for (const target of TARGETS) {
  const committedPath = join(ROOT, target.committed)
  if (!existsSync(committedPath)) {
    console.error(`✗ ${target.label}: ${target.committed} is missing entirely — run \`${target.fix}\``)
    failed = true
    continue
  }

  const regenerated = join(scratch, target.committed.replace(/[\\/]/g, '_'))
  try {
    target.regenerate(regenerated)
  } catch (err) {
    console.error(`✗ ${target.label}: regeneration failed\n${err.stderr?.toString() ?? err.message}`)
    failed = true
    continue
  }

  const before = normalise(readFileSync(committedPath, 'utf8'))
  const after = normalise(readFileSync(regenerated, 'utf8'))

  if (before === after) {
    console.log(`✓ ${target.label} is up to date (${(after.length / 1024).toFixed(1)} kB)`)
    continue
  }

  failed = true
  console.error(
    `✗ ${target.label}: ${target.committed} is stale.\n` +
      `  The committed file no longer matches what its source generates, so a\n` +
      `  release build would ship the older behaviour. Run \`${target.fix}\` and commit.`,
  )

  // A first differing line is far more useful than "they differ".
  const a = before.split('\n')
  const b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  first difference at line ${i + 1}:`)
      console.error(`    committed:   ${(a[i] ?? '<end of file>').slice(0, 120)}`)
      console.error(`    regenerated: ${(b[i] ?? '<end of file>').slice(0, 120)}`)
      break
    }
  }
}

rmSync(scratch, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
