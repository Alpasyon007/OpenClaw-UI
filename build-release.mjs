// One-shot release build for the saucer app.
//
// Four artefacts have to stay in step: the renderer bundle, the generated clui
// shim, the esbuilt sidecar, and the C++ shell. Building them by hand in the
// wrong order is how a stale shim ends up shipping against a new preload, so
// this does the whole chain.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = import.meta.dirname
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

console.log('\n[1/5] renderer')
run('npm', ['run', 'build'])

console.log('\n[2/5] deploy renderer -> shell/web')
const web = join(root, 'shell', 'web')
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

console.log('\n[3/5] clui shim (generated from the preload)')
run('node', ['sidecar/gen-shim.mjs', 'src/preload/index.ts', 'src/shared/types.ts', 'shell/web/clui-shim.js'])
run('node', ['--check', 'shell/web/clui-shim.js'])

console.log('\n[4/5] sidecar bundle')
run('npx', ['--no-install', 'esbuild', 'sidecar/index.ts', '--bundle', '--platform=node',
  '--format=esm', '--target=node22', '--external:node-pty', '--minify',
  '--outfile=shell/sidecar/main.mjs'])

console.log('\n[5/5] shell (C++, Release)')
run('cmake', ['--build', 'build', '--config', 'Release'], join(root, 'shell'))

// Stage a clean, self-contained folder rather than shipping the build tree.
const out = join(root, 'release')
if (existsSync(out)) rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, 'shell', 'build', 'Release'), out, {
  recursive: true,
  filter: (src) => !/\.(log|pdb|ilk|exp|lib)$/i.test(src),
})
console.log(`\nstaged -> ${out}`)
