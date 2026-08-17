/**
 * base64url, unpadded — the encoding the gateway uses for public keys and
 * signatures.
 *
 * Hand-rolled rather than delegating to `Buffer` or `btoa`, because this module
 * has to run unchanged in three places: Node (sidecar and tests), a browser
 * (the renderer, eventually) and Hermes (React Native). `Buffer` does not exist
 * in Hermes, and `btoa`/`atob` are not guaranteed there either — React Native
 * ships them only via polyfill, and only for some template configurations.
 *
 * The decoder accepts standard base64 as well as base64url. The gateway's own
 * decoder does the same, and a client that rejected padded input would fail
 * against a perfectly valid value it had round-tripped through some other tool.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Reverse lookup covering both alphabets, so `+`/`/` decode alongside `-`/`_`. */
const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  table['+'.charCodeAt(0)] = 62
  table['/'.charCodeAt(0)] = 63
  return table
})()

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out +=
      ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63] + ALPHABET[n & 63]
  }

  // Trailing 1 or 2 bytes. Padding is omitted rather than emitted and stripped,
  // which is what the gateway compares against.
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63]
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63]
  }

  return out
}

/**
 * Decode base64url or base64.
 *
 * Throws on a character outside both alphabets. That is deliberate: this decodes
 * key material, and silently skipping an unexpected byte would yield a key that
 * is subtly wrong rather than one that is obviously invalid.
 */
export function base64UrlDecode(input: string): Uint8Array {
  let clean = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '=' || ch === '\n' || ch === '\r') continue
    const code = input.charCodeAt(i)
    if (code > 127 || LOOKUP[code] === -1) {
      throw new Error(`invalid base64url input at index ${i}`)
    }
    clean += ch
  }

  const fullGroups = Math.floor(clean.length / 4)
  const remainder = clean.length % 4
  if (remainder === 1) throw new Error('invalid base64url length')

  const outLength = fullGroups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0)
  const out = new Uint8Array(outLength)

  let o = 0
  let i = 0
  for (let g = 0; g < fullGroups; g++, i += 4) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      (LOOKUP[clean.charCodeAt(i + 2)] << 6) |
      LOOKUP[clean.charCodeAt(i + 3)]
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
    out[o++] = n & 255
  }

  if (remainder === 2) {
    const n = (LOOKUP[clean.charCodeAt(i)] << 18) | (LOOKUP[clean.charCodeAt(i + 1)] << 12)
    out[o++] = (n >>> 16) & 255
  } else if (remainder === 3) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      (LOOKUP[clean.charCodeAt(i + 2)] << 6)
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
  }

  return out
}

/** UTF-8 encode. `TextEncoder` exists in Node, browsers and Hermes. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
