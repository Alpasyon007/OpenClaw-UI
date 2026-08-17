import { describe, it, expect } from 'vitest'
import { base64UrlEncode, base64UrlDecode, utf8Bytes } from './base64url'

/** Independent oracle. The implementation deliberately avoids Buffer; tests need not. */
const nodeEncode = (b: Uint8Array): string =>
  Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')

describe('base64UrlEncode', () => {
  it.each([
    [0, ''],
    [1, ''],
    [2, ''],
    [3, ''],
    [31, ''],
    [32, ''],
    [64, ''],
    [65, ''],
  ])('matches Node for a %i-byte input', (length) => {
    // Every residue class mod 3 is covered, which is where hand-rolled base64
    // implementations go wrong — the 1- and 2-byte tails.
    const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 255)
    expect(base64UrlEncode(bytes)).toBe(nodeEncode(bytes))
  })

  it('never emits padding or the standard-alphabet characters', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 251 + 3) & 255)
      const encoded = base64UrlEncode(bytes)
      expect(encoded).not.toMatch(/[=+/]/)
    }
  })

  it('covers the full byte range', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    expect(base64UrlEncode(bytes)).toBe(nodeEncode(bytes))
  })

  it('encodes an empty input as an empty string', () => {
    expect(base64UrlEncode(new Uint8Array(0))).toBe('')
  })
})

describe('base64UrlDecode', () => {
  it('round-trips every length up to 64 bytes', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 97 + 5) & 255)
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('accepts standard base64 as well as base64url', () => {
    // The gateway's own decoder is equally permissive. Rejecting padded or
    // +/-alphabet input would fail on a value that had merely been round-tripped
    // through another tool.
    const bytes = new Uint8Array([251, 255, 190, 239, 0, 1])
    const standard = Buffer.from(bytes).toString('base64')
    expect(standard).toMatch(/[+/=]/)
    expect(Array.from(base64UrlDecode(standard))).toEqual(Array.from(bytes))
  })

  it('ignores padding and line breaks', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const padded = Buffer.from(bytes).toString('base64')
    expect(Array.from(base64UrlDecode(`${padded}\n`))).toEqual(Array.from(bytes))
  })

  it.each([
    ['a non-alphabet character', 'ab*d'],
    ['a non-ASCII character', 'abcé'],
    ['an impossible length', 'a'],
  ])('throws on %s rather than decoding silently', (_label, input) => {
    // This decodes key material. Skipping an unexpected byte would produce a
    // key that is subtly wrong instead of one that is obviously invalid, and the
    // resulting failure surfaces much later as an opaque auth rejection.
    expect(() => base64UrlDecode(input)).toThrow()
  })

  it('decodes an empty string to an empty array', () => {
    expect(base64UrlDecode('')).toHaveLength(0)
  })
})

describe('utf8Bytes', () => {
  it('matches Node for ASCII and beyond', () => {
    for (const text of ['', 'hello', 'v3|abc|operator', 'Ångström', '🔐 approve', '日本語']) {
      expect(Array.from(utf8Bytes(text))).toEqual(Array.from(Buffer.from(text, 'utf8')))
    }
  })
})
