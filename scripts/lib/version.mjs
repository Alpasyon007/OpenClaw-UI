/**
 * Version, from one source.
 *
 * The root `package.json` is the truth. Everything else — the workspace
 * packages, the mobile app, the C++ shell's Windows resource, the installer —
 * derives from it, because a version that is typed into eight files is a
 * version that is wrong in at least one of them.
 *
 * The awkward part is Windows. `VERSIONINFO` carries two different things and
 * they are not interchangeable:
 *
 *   FILEVERSION / PRODUCTVERSION   four 16-bit integers, compared numerically
 *   FileVersion / ProductVersion   free strings, shown to humans
 *
 * A semver prerelease (`0.2.0-rc.1`) is legal in the strings and impossible in
 * the integers. Writing `0.2.0-rc.1` into FILEVERSION does not fail loudly — the
 * resource compiler takes the numeric prefix and silently drops the rest, so
 * `0.2.0-rc.1` and `0.2.0` become the same build as far as Windows is concerned,
 * and an installer's "is this newer?" check stops working. Hence
 * {@link toWindowsQuad}, which is explicit about what it discards.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Semver, loosely: the three numbers plus optional prerelease and build. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export function parseVersion(raw) {
  const match = SEMVER.exec(String(raw ?? '').trim())
  if (!match) throw new Error(`not a semver version: ${JSON.stringify(raw)}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
  }
}

/** The version as written in the root package.json. */
export function readVersion(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  parseVersion(pkg.version)
  return pkg.version
}

/**
 * The numeric core, with the prerelease dropped.
 *
 * CMake's `project(VERSION)` and the Windows resource integers both refuse
 * anything else.
 */
export function toNumericCore(raw) {
  const { major, minor, patch } = parseVersion(raw)
  return `${major}.${minor}.${patch}`
}

/**
 * Four comma-separated integers for FILEVERSION / PRODUCTVERSION.
 *
 * The fourth is a build number, defaulting to 0. A prerelease sorts *below* its
 * release in semver but there is nowhere to say so in four integers, so it is
 * simply absent — callers that need the distinction must read the string form.
 *
 * Every part is clamped to 65535: these are 16-bit fields, and a CI run number
 * that overflows wraps silently rather than erroring, which would make a newer
 * build look older.
 */
export function toWindowsQuad(raw, buildNumber = 0) {
  const { major, minor, patch } = parseVersion(raw)
  const clamp = (n) => Math.max(0, Math.min(65535, Math.trunc(Number(n) || 0)))
  return [clamp(major), clamp(minor), clamp(patch), clamp(buildNumber)].join(',')
}

/**
 * The build number for this build.
 *
 * Taken from CI when present so successive builds of the same version are
 * distinguishable; 0 locally, where they are not meant to be.
 */
export function buildNumberFromEnv(env = process.env) {
  const raw = env.OPENCLAW_BUILD_NUMBER ?? env.GITHUB_RUN_NUMBER ?? env.BUILD_BUILDID ?? '0'
  const n = Number.parseInt(String(raw), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * The human-facing version string.
 *
 * Carries the prerelease, unlike {@link toWindowsQuad}. This is what the
 * installer shows, what Explorer's Details tab shows, and what a bug report
 * should quote.
 */
export function displayVersion(raw, buildNumber = 0) {
  return buildNumber > 0 ? `${raw}+${buildNumber}` : String(raw)
}

/** True when this version is a prerelease, which installers may treat apart. */
export function isPrerelease(raw) {
  return parseVersion(raw).prerelease !== null
}

/**
 * Android's `versionCode`: one increasing integer.
 *
 * It is what the store and the device compare, and a semver string cannot be
 * one. Packing the three parts preserves semver's ordering — as long as minor
 * and patch stay under 100, which is a real bound and better stated here than
 * discovered when 1.0.100 sorts below 1.1.0.
 *
 * Throws rather than truncating: a versionCode that goes backwards cannot be
 * shipped, and a build failure is the cheapest way to find out.
 */
export function androidVersionCode(raw) {
  const { major, minor, patch } = parseVersion(raw)
  if (minor > 99 || patch > 99) {
    throw new Error(
      `version ${raw} cannot be packed into an Android versionCode: minor and patch must stay under 100`,
    )
  }
  return major * 10000 + minor * 100 + patch
}
