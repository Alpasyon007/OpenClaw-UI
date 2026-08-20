// One-shot release build for the saucer app.
//
// Four artefacts have to stay in step: the renderer bundle, the generated clui
// shim, the esbuilt sidecar, and the C++ shell. Building them by hand in the
// wrong order is how a stale shim ends up shipping against a new contract, so
// this does the whole chain.
//
// Usage:
//   node build-release.mjs            everything, ending in a staged release/
//   node build-release.mjs --web      the JS half only (no C++ toolchain needed)
//
// --web exists because the first four stages need nothing but Node, while the
// fifth needs CMake, a C++ compiler and the saucer dependencies. CI runs --web;
// so does anyone touching only the renderer, the contract or the sidecar.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const webOnly = process.argv.includes('--web')
const total = webOnly ? 4 : 5

// Where the finished tree is staged. Overridable because `release/` is also
// where people run the app from, and a running launcher holds its own exe open
// — the wipe below then fails with EPERM and takes the whole build with it.
// The installer stages somewhere of its own for exactly that reason.
const outFlag = process.argv.indexOf('--out')
const outDir = outFlag >= 0 ? process.argv[outFlag + 1] : 'release'
if (outFlag >= 0 && !outDir) {
  console.error('--out needs a directory')
  process.exit(1)
}

const root = import.meta.dirname
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

console.log(`\n[1/${total}] renderer`)
run('npm', ['run', 'build'])

console.log(`\n[2/${total}] deploy renderer -> shell/web`)
const web = join(root, 'shell', 'web')
// Clear the old asset folder first. Vite content-hashes filenames, so copying
// over the top accumulates every bundle ever built while index.html references
// only the newest — the stale ones just sit there and ship.
rmSync(join(web, 'assets'), { recursive: true, force: true })
cpSync(join(root, 'dist', 'renderer'), web, { recursive: true })

// window.clui must exist before the app module runs, so the shim is a classic
// script injected ahead of it. Re-applied here because the renderer build
// overwrites index.html every time.
const indexPath = join(web, 'index.html')
let html = readFileSync(indexPath, 'utf-8')
if (!html.includes('clui-shim.js')) {
  html = html.replace('<script type="module"', '<script src="./clui-shim.js"></script>\n    <script type="module"', 1)
  writeFileSync(indexPath, html)
}

console.log(`\n[3/${total}] clui shim (generated from the contract)`)
run('node', ['sidecar/gen-shim.mjs', 'src/shared/clui-contract.ts', 'src/shared/types.ts', 'shell/web/clui-shim.js'])
run('node', ['--check', 'shell/web/clui-shim.js'])

console.log(`\n[4/${total}] sidecar bundle`)
// Emitted as CommonJS, not ESM, and this matters: node-pty is a native module
// that stays external, and pty-run-manager loads it with require(). ESM has no
// require, so esbuild substitutes a shim that throws "Dynamic require of ...",
// which pty-run-manager catches and reports as "node-pty is not available".
// CJS gives a real require and the module loads. A .cjs extension is required
// because .mjs would force ESM regardless of the format flag.
run('npx', ['--no-install', 'esbuild', 'sidecar/index.ts', '--bundle', '--platform=node',
  '--format=cjs', '--target=node22', '--external:node-pty', '--minify',
  '--outfile=shell/sidecar/main.cjs'])

if (webOnly) {
  console.log('\n--web: skipping the C++ shell. shell/web and shell/sidecar are up to date.')
  process.exit(0)
}

console.log('\n[5/5] shell (C++, Release)')
// Configure on first use. `cmake --build` on an unconfigured directory fails
// with a bare "could not load cache", which reads as a broken checkout rather
// than a missing step.
const shell = join(root, 'shell')

// The fourth part of the executable's FILEVERSION is a CMake cache variable, so
// it is fixed at configure time rather than build time. Reconfiguring on every
// build would add ~30s for nothing on a developer machine, where the number is
// always 0 — so it is only forced when something actually set one.
const buildNumber = process.env.OPENCLAW_BUILD_NUMBER ?? '0'
const configured = existsSync(join(shell, 'build', 'CMakeCache.txt'))
if (!configured) {
  console.log('  (no build cache — configuring first; this fetches saucer)')
  run('cmake', ['-S', '.', '-B', 'build', `-DOPENCLAW_BUILD_NUMBER=${buildNumber}`], shell)
} else if (buildNumber !== '0') {
  console.log(`  (build number ${buildNumber} — reconfiguring)`)
  run('cmake', ['-S', '.', '-B', 'build', `-DOPENCLAW_BUILD_NUMBER=${buildNumber}`], shell)
}
run('cmake', ['--build', 'build', '--config', 'Release'], shell)

// Stage a clean, self-contained folder rather than shipping the build tree.
const out = join(root, outDir)
if (existsSync(out)) {
  try {
    rmSync(out, { recursive: true, force: true })
  } catch (err) {
    // Almost always a running instance holding its own executable open. The
    // raw EPERM names the directory and not the cause, which sends people
    // looking at permissions.
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      console.error('')
      console.error(`Cannot clear ${out} — something is using it.`)
      console.error('A running OpenClaw window is the usual reason. Close it, or stage elsewhere:')
      console.error('  node build-release.mjs --out dist/stage')
      console.error('')
      process.exit(1)
    }
    throw err
  }
}
mkdirSync(out, { recursive: true })
cpSync(join(root, 'shell', 'build', 'Release'), out, {
  recursive: true,
  filter: (src) => !/\.(log|pdb|ilk|exp|lib)$/i.test(src),
})
console.log(`\nstaged -> ${out}`)
