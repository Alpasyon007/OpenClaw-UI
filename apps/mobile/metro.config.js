/**
 * Metro, taught about the npm workspace.
 *
 * Three settings, each fixing a failure that is otherwise baffling:
 *
 *  - `watchFolders` — the shared packages live outside this app's directory, so
 *    without this Metro neither resolves nor hot-reloads them.
 *  - `nodeModulesPaths` — dependencies are hoisted to the repo root by npm
 *    workspaces, so the app's own `node_modules` is nearly empty.
 *  - `disableHierarchicalLookup: false` — left on deliberately; turning it off
 *    is a common monorepo cargo-cult that breaks hoisted resolution here.
 *
 * The shared packages are consumed as **source TypeScript**, not build output.
 * Metro compiles them itself, so there is no build step to keep in sync and no
 * stale `dist/` to ship by accident.
 */
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = false

module.exports = config
