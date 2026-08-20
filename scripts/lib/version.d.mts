/**
 * Types for `version.mjs`.
 *
 * The implementation stays JavaScript because the build scripts are run
 * directly by node with no compile step; this declaration is what lets the
 * test suite — and any editor — typecheck against it.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** `rc.1` in `1.2.3-rc.1`, or null. */
  prerelease: string | null
  /** `abc` in `1.2.3+abc`, or null. */
  build: string | null
}

export const REPO_ROOT: string

/** Throws on anything that is not semver, rather than guessing. */
export function parseVersion(raw: string): ParsedVersion

/** The version in the root package.json, validated. */
export function readVersion(root?: string): string

/** The `major.minor.patch` core, with any prerelease dropped. */
export function toNumericCore(raw: string): string

/** Four comma-separated integers for FILEVERSION / PRODUCTVERSION. */
export function toWindowsQuad(raw: string, buildNumber?: number): string

/** Build number from CI, or 0 locally. */
export function buildNumberFromEnv(env?: Record<string, string | undefined>): number

/** The human-facing string, prerelease and all. */
export function displayVersion(raw: string, buildNumber?: number): string

export function isPrerelease(raw: string): boolean

/** One increasing integer for Android. Throws if the version cannot be packed. */
export function androidVersionCode(raw: string): number
