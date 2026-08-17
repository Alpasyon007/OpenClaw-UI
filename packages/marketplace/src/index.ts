/**
 * `@openclaw/marketplace` — the skill catalogue, as data.
 *
 * Pure and runtime-free: no filesystem, no child process, no DOM. Fetching is
 * injected, so the same module builds the catalogue inside the desktop sidecar
 * (Node) and on the phone (Hermes), and the parsers can be tested against
 * fixtures with no network at all.
 *
 * Installing is *not* here, because it is not portable: the desktop writes a
 * `SKILL.md` to disk, and the phone has to ask the gateway to do it.
 */
export * from './types'
export * from './parse'
export * from './catalog'
export * from './skill-md'
