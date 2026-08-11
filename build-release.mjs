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
if (!existsSync(join(shell, 'build', 'CMakeCache.txt'))) {
  console.log('  (no build cache — configuring first; this fetches saucer)')
  run('cmake', ['-S', '.', '-B', 'build'], shell)
}
run('cmake', ['--build', 'build', '--config', 'Release'], shell)

// Stage a clean, self-contained folder rather than shipping the build tree.
const out = join(root, 'release')
if (existsSync(out)) rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, 'shell', 'build', 'Release'), out, {
  recursive: true,
  filter: (src) => !/\.(log|pdb|ilk|exp|lib)$/i.test(src),
})
console.log(`\nstaged -> ${out}`)
