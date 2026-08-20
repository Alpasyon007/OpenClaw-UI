/**
 * Version derivation.
 *
 * The rules that matter are about Windows, which carries the version twice —
 * as four integers it compares, and as a string it shows. A prerelease is legal
 * in one and impossible in the other, and getting that wrong does not fail
 * loudly: the resource compiler takes the numeric prefix and drops the rest, so
 * two different builds compare as identical and upgrade detection quietly stops
 * working.
 */
import { describe, expect, it } from 'vitest'
import {
  androidVersionCode,
  buildNumberFromEnv,
  displayVersion,
  isPrerelease,
  parseVersion,
  readVersion,
  toNumericCore,
  toWindowsQuad,
} from '../../scripts/lib/version.mjs'

describe('parseVersion', () => {
  it('reads the three numbers plus optional tags', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseVersion('1.2.3-rc.1')).toMatchObject({ prerelease: 'rc.1' })
    expect(parseVersion('1.2.3+abc')).toMatchObject({ build: 'abc' })
  })

  it('rejects anything that is not semver, rather than guessing', () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '', 'latest', null]) {
      expect(() => parseVersion(bad as string)).toThrow(/semver/)
    }
  })
})

describe('toNumericCore', () => {
  it('drops a prerelease, which CMake and the resource integers refuse', () => {
    expect(toNumericCore('0.2.0-rc.1')).toBe('0.2.0')
    expect(toNumericCore('1.2.3')).toBe('1.2.3')
  })
})

describe('toWindowsQuad', () => {
  it('emits four comma-separated integers', () => {
    expect(toWindowsQuad('1.2.3', 44)).toBe('1,2,3,44')
  })

  it('defaults the build number to zero', () => {
    expect(toWindowsQuad('1.2.3')).toBe('1,2,3,0')
  })

  it('drops the prerelease rather than emitting something the RC would mangle', () => {
    expect(toWindowsQuad('1.2.3-rc.1', 7)).toBe('1,2,3,7')
  })

  it('clamps to 16 bits so a large run number cannot wrap into a smaller one', () => {
    // Silently wrapping would make a newer build compare as older, which is the
    // one failure mode an upgrade check must not have.
    expect(toWindowsQuad('1.2.3', 70000)).toBe('1,2,3,65535')
    expect(toWindowsQuad('1.2.3', -5)).toBe('1,2,3,0')
  })
})

describe('buildNumberFromEnv', () => {
  it('prefers an explicit override, then CI variables', () => {
    expect(buildNumberFromEnv({ OPENCLAW_BUILD_NUMBER: '12' })).toBe(12)
    expect(buildNumberFromEnv({ GITHUB_RUN_NUMBER: '34' })).toBe(34)
    expect(buildNumberFromEnv({ BUILD_BUILDID: '56' })).toBe(56)
  })

  it('is zero locally, where successive builds are not meant to differ', () => {
    expect(buildNumberFromEnv({})).toBe(0)
    expect(buildNumberFromEnv({ GITHUB_RUN_NUMBER: 'not-a-number' })).toBe(0)
  })
})

describe('displayVersion', () => {
  it('keeps the prerelease and appends a build number when there is one', () => {
    expect(displayVersion('1.2.3-rc.1', 9)).toBe('1.2.3-rc.1+9')
    expect(displayVersion('1.2.3', 0)).toBe('1.2.3')
  })
})

describe('isPrerelease', () => {
  it('distinguishes a release from a candidate', () => {
    expect(isPrerelease('1.0.0')).toBe(false)
    expect(isPrerelease('1.0.0-beta.2')).toBe(true)
  })
})

describe('androidVersionCode', () => {
  it('packs semver into one increasing integer', () => {
    expect(androidVersionCode('0.1.0')).toBe(100)
    expect(androidVersionCode('1.2.3')).toBe(10203)
  })

  it('orders the way semver does', () => {
    expect(androidVersionCode('1.2.0')).toBeGreaterThan(androidVersionCode('1.1.9'))
    expect(androidVersionCode('2.0.0')).toBeGreaterThan(androidVersionCode('1.99.99'))
  })

  it('refuses a version it cannot pack, rather than producing a smaller code', () => {
    // 1.0.100 would collide with 1.1.0 and sort below it. Failing the build is
    // the only safe answer: a versionCode that goes backwards cannot be shipped.
    expect(() => androidVersionCode('1.0.100')).toThrow(/versionCode/)
  })
})

describe('readVersion', () => {
  it('reads the repo version and validates it', () => {
    expect(() => parseVersion(readVersion())).not.toThrow()
  })
})
