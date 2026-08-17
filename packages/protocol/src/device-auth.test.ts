import { describe, it, expect } from 'vitest'
import {
  buildDeviceAuthPayloadV2,
  buildDeviceAuthPayloadV3,
  normalizeDeviceMetadataForAuth,
  resolveSignatureToken,
  isSignatureFresh,
  DEVICE_SIGNATURE_SKEW_MS,
} from './device-auth'

const base = {
  deviceId: 'a'.repeat(64),
  clientId: 'openclaw-android',
  clientMode: 'ui',
  role: 'operator' as const,
  scopes: ['operator.read', 'operator.write', 'operator.approvals'],
  signedAtMs: 1_700_000_000_000,
  token: 'tok',
  nonce: 'nonce-1',
}

describe('buildDeviceAuthPayloadV3', () => {
  it('produces the exact positional format the server reconstructs', () => {
    // Pinned literally. This string is compared byte-for-byte against one the
    // gateway builds independently; a "harmless" reformatting here zeroes the
    // client's scopes at runtime with no error that names the cause.
    expect(buildDeviceAuthPayloadV3({ ...base, platform: 'android', deviceFamily: 'Android' })).toBe(
      'v3|' +
        'a'.repeat(64) +
        '|openclaw-android|ui|operator|operator.read,operator.write,operator.approvals|1700000000000|tok|nonce-1|android|android',
    )
  })

  it('has exactly eleven segments', () => {
    const payload = buildDeviceAuthPayloadV3({ ...base, platform: 'android' })
    expect(payload.split('|')).toHaveLength(11)
  })

  it('preserves scope order rather than sorting', () => {
    // The server joins the array it received, unsorted. Sorting here would
    // produce a payload that cannot match whenever the caller's order differs.
    const payload = buildDeviceAuthPayloadV3({
      ...base,
      scopes: ['operator.write', 'operator.approvals', 'operator.read'],
      platform: 'android',
    })
    expect(payload).toContain('|operator.write,operator.approvals,operator.read|')
  })

  it('does not dedupe scopes', () => {
    const payload = buildDeviceAuthPayloadV3({
      ...base,
      scopes: ['operator.read', 'operator.read'],
      platform: 'android',
    })
    expect(payload).toContain('|operator.read,operator.read|')
  })

  it('renders an empty scope list as an empty segment', () => {
    const payload = buildDeviceAuthPayloadV3({ ...base, scopes: [], platform: 'android' })
    expect(payload.split('|')[5]).toBe('')
  })

  it('renders a null token as an empty segment, not the string "null"', () => {
    const payload = buildDeviceAuthPayloadV3({ ...base, token: null, platform: 'android' })
    expect(payload.split('|')[7]).toBe('')
    expect(payload).not.toContain('null')
  })

  it('renders signedAtMs as plain decimal', () => {
    const payload = buildDeviceAuthPayloadV3({ ...base, platform: 'android' })
    expect(payload.split('|')[6]).toBe('1700000000000')
  })

  it('renders a missing deviceFamily as an empty trailing segment', () => {
    const payload = buildDeviceAuthPayloadV3({ ...base, platform: 'android' })
    const parts = payload.split('|')
    expect(parts).toHaveLength(11)
    expect(parts[10]).toBe('')
  })

  it('normalizes platform and deviceFamily but not the other fields', () => {
    const payload = buildDeviceAuthPayloadV3({
      ...base,
      clientId: 'openclaw-android',
      platform: '  Android  ',
      deviceFamily: 'Pixel',
    })
    const parts = payload.split('|')
    expect(parts[9]).toBe('android')
    expect(parts[10]).toBe('pixel')
    // The nonce is echoed verbatim — normalizing it would break the match.
    expect(parts[8]).toBe('nonce-1')
  })
})

describe('buildDeviceAuthPayloadV2', () => {
  it('is v3 minus the two metadata fields', () => {
    const v2 = buildDeviceAuthPayloadV2(base)
    expect(v2.split('|')).toHaveLength(9)
    expect(v2.startsWith('v2|')).toBe(true)
  })

  it('shares every field with v3 up to the version tag', () => {
    const v2 = buildDeviceAuthPayloadV2(base)
    const v3 = buildDeviceAuthPayloadV3({ ...base, platform: 'android', deviceFamily: 'Android' })
    expect(v3.startsWith(`v3|${v2.slice('v2|'.length)}|`)).toBe(true)
  })
})

describe('normalizeDeviceMetadataForAuth', () => {
  it.each([
    ['Android', 'android'],
    ['  Windows  ', 'windows'],
    ['macOS', 'macos'],
    ['', ''],
    ['   ', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeDeviceMetadataForAuth(input)).toBe(expected)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('maps %s to an empty string', (_label, input) => {
    expect(normalizeDeviceMetadataForAuth(input)).toBe('')
  })

  it('shifts only ASCII A-Z, matching the server byte for byte', () => {
    // The server does a 0x20 shift over /[A-Z]/, not a locale-aware lowercase.
    // Non-ASCII uppercase therefore SURVIVES, where toLowerCase() would fold it
    // — so a device family carrying an accented capital signs differently under
    // the two implementations. Asserting the un-folded form is the whole point:
    // this must match the gateway, not match intuition.
    expect(normalizeDeviceMetadataForAuth('ÅNGSTRÖM')).toBe('ÅngstrÖm')
    expect('ÅNGSTRÖM'.toLowerCase()).not.toBe(normalizeDeviceMetadataForAuth('ÅNGSTRÖM'))

    expect(normalizeDeviceMetadataForAuth('İ')).toBe('İ')
    expect(normalizeDeviceMetadataForAuth('Ä')).toBe('Ä')
    // Plain ASCII still behaves the obvious way.
    expect(normalizeDeviceMetadataForAuth('I')).toBe('i')
  })
})

describe('resolveSignatureToken', () => {
  it('follows the server precedence: token, deviceToken, bootstrapToken', () => {
    expect(resolveSignatureToken({ token: 'a', deviceToken: 'b', bootstrapToken: 'c' })).toBe('a')
    expect(resolveSignatureToken({ deviceToken: 'b', bootstrapToken: 'c' })).toBe('b')
    expect(resolveSignatureToken({ bootstrapToken: 'c' })).toBe('c')
  })

  it('returns null when nothing is set, which the payload renders as empty', () => {
    expect(resolveSignatureToken({})).toBeNull()
    expect(resolveSignatureToken(undefined)).toBeNull()
  })
})

describe('isSignatureFresh', () => {
  const now = 1_700_000_000_000

  it('accepts a signature at the current time', () => {
    expect(isSignatureFresh(now, now)).toBe(true)
  })

  it('accepts skew in both directions up to the limit', () => {
    // The window is symmetric and absolute — a client clock running fast is
    // just as acceptable as one running slow.
    expect(isSignatureFresh(now - DEVICE_SIGNATURE_SKEW_MS, now)).toBe(true)
    expect(isSignatureFresh(now + DEVICE_SIGNATURE_SKEW_MS, now)).toBe(true)
  })

  it('rejects beyond the limit in both directions', () => {
    expect(isSignatureFresh(now - DEVICE_SIGNATURE_SKEW_MS - 1, now)).toBe(false)
    expect(isSignatureFresh(now + DEVICE_SIGNATURE_SKEW_MS + 1, now)).toBe(false)
  })

  it.each([NaN, Infinity, -Infinity])('rejects the non-finite value %s', (value) => {
    expect(isSignatureFresh(value, now)).toBe(false)
  })
})
