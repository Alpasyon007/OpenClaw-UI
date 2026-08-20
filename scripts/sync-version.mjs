#!/usr/bin/env node
/**
 * Propagate the root version to everything that has to agree with it.
 *
 * Run `npm run version:sync` after bumping `package.json`. `--check` verifies
 * without writing and is wired into `npm run verify`, so a bump that forgets a
 * file fails the build rather than shipping a mixed-version release.
 *
 * The C++ shell is deliberately *not* in this list. It reads package.json at
 * configure time (see shell/CMakeLists.txt), which is strictly better than
 * copying the number into a second place and hoping the two stay level.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { REPO_ROOT, androidVersionCode, readVersion } from './lib/version.mjs'

const check = process.argv.includes('--check')
const version = readVersion()

const edits = []

/** Queue a JSON edit, described so --check can report it without applying. */
function setJson(relPath, apply, describe) {
  const abs = join(REPO_ROOT, relPath)
  const raw = readFileSync(abs, 'utf-8')
  const data = JSON.parse(raw)
  const before = JSON.stringify(data)
  apply(data)
  if (JSON.stringify(data) === before) return

  edits.push({ relPath, describe: describe(data) })
  if (!check) {
    // Preserve the trailing newline convention; npm rewrites these files too.
    writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`)
  }
}

// Workspace packages: they are private and never published, but a stale
// version here is what makes `npm ls` and any future publish disagree.
for (const dir of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  setJson(`packages/${dir.name}/package.json`, (d) => { d.version = version }, () => `-> ${version}`)
}

setJson('apps/mobile/package.json', (d) => { d.version = version }, () => `-> ${version}`)

setJson(
  'apps/mobile/app.json',
  (d) => {
    d.expo.version = version
    d.expo.android = { ...d.expo.android, versionCode: androidVersionCode(version) }
    // iOS wants a string, and one that increases per submitted build.
    d.expo.ios = { ...d.expo.ios, buildNumber: String(androidVersionCode(version)) }
  },
  (d) => `-> ${version} (versionCode ${d.expo.android.versionCode})`,
)

if (edits.length === 0) {
  console.log(`version ${version}: everything already in step`)
  process.exit(0)
}

for (const edit of edits) console.log(`${check ? 'stale' : 'updated'}  ${edit.relPath}  ${edit.describe}`)

if (check) {
  console.error(`\n${edits.length} file(s) disagree with package.json (${version}). Run: npm run version:sync`)
  process.exit(1)
}
console.log(`\nversion ${version} propagated to ${edits.length} file(s)`)
