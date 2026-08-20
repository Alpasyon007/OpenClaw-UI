#!/usr/bin/env node
/**
 * Build the Windows installer.
 *
 * Stages a release with build-release.mjs, then compiles installer/*.iss with
 * Inno Setup's command-line compiler. The version comes from package.json and
 * is passed in rather than written into the .iss, so the installer, the
 * executable's resource and package.json cannot disagree.
 *
 * Usage:
 *   node scripts/build-installer.mjs              full build, then compile
 *   node scripts/build-installer.mjs --skip-build compile whatever is in release/
 *
 * ISCC is found via $ISCC, then $INNO_SETUP_PATH, then the usual install
 * locations. Inno Setup installs per-user by default, which is why
 * %LOCALAPPDATA% is checked before Program Files.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, buildNumberFromEnv, readVersion, toWindowsQuad } from './lib/version.mjs'

const skipBuild = process.argv.includes('--skip-build')

const version = readVersion()
const buildNumber = buildNumberFromEnv()
// Dots, not commas: Inno's VersionInfoVersion wants a dotted quad, while the
// resource compiler wants commas. Same four numbers, two syntaxes.
const quad = toWindowsQuad(version, buildNumber).replace(/,/g, '.')

function findCompiler() {
  const candidates = [
    process.env.ISCC,
    process.env.INNO_SETUP_PATH && join(process.env.INNO_SETUP_PATH, 'ISCC.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const iscc = findCompiler()
if (!iscc) {
  console.error(
    'Inno Setup 6 was not found.\n\n' +
      '  winget install JRSoftware.InnoSetup\n\n' +
      'or set ISCC to the full path of ISCC.exe.',
  )
  process.exit(1)
}

// Deliberately not `release/`: that is where the app is usually run from, and
// a running launcher holds its own executable open, so clearing it fails.
const STAGE_DIR = 'dist/stage'
const staged = join(REPO_ROOT, STAGE_DIR)

if (!skipBuild) {
  console.log(`\n=== release build (v${version}) ===`)
  execFileSync(process.execPath, ['build-release.mjs', '--out', STAGE_DIR], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // The shell's FILEVERSION fourth part comes from here, so a CI build number
    // reaches the executable as well as the installer.
    env: { ...process.env, OPENCLAW_BUILD_NUMBER: String(buildNumber) },
  })
}

if (!existsSync(staged) || readdirSync(staged).length === 0) {
  console.error(`Nothing staged in ${staged}. Run without --skip-build.`)
  process.exit(1)
}

const exe = join(staged, 'openclaw-shell.exe')
if (!existsSync(exe)) {
  // Catching this here beats an installer that builds happily and installs an
  // app with no executable in it.
  console.error(`${exe} is missing — the C++ shell did not build.`)
  process.exit(1)
}

const outDir = join(REPO_ROOT, 'dist', 'installer')
mkdirSync(outDir, { recursive: true })

console.log(`\n=== installer (v${version}, file version ${quad}) ===`)
execFileSync(
  iscc,
  [
    `/DAppVersion=${version}`,
    `/DVersionQuad=${quad}`,
    `/DSourceDir=${staged}`,
    `/DOutputDir=${outDir}`,
    join(REPO_ROOT, 'installer', 'openclaw-ui.iss'),
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)

const produced = readdirSync(outDir)
  .filter((f) => f.endsWith('.exe'))
  .map((f) => ({ name: f, ...statSync(join(outDir, f)) }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

if (produced) {
  console.log(`\n-> ${join(outDir, produced.name)}  (${(produced.size / 1024 / 1024).toFixed(1)} MB)`)
  console.log('\nNote: unsigned. Windows SmartScreen will warn on first run.')
}
