import { describe, expect, it } from 'vitest'
import {
  CapabilityCache,
  explainCapability,
  isMissingScopeError,
  isUnsupportedMethodError,
} from './capabilities'

const err = (code: string, message: string) => ({ code, message })

describe('isUnsupportedMethodError', () => {
  it('recognises the wordings a gateway uses for an unrouted method', () => {
    expect(isUnsupportedMethodError(err('INVALID_REQUEST', 'unknown method skills.install'))).toBe(true)
    expect(isUnsupportedMethodError(err('INVALID_REQUEST', 'Method not found'))).toBe(true)
    expect(isUnsupportedMethodError(err('INVALID_REQUEST', 'no such method: config.get'))).toBe(true)
    expect(isUnsupportedMethodError(err('UNAVAILABLE', 'not implemented'))).toBe(true)
  })

  it('does not treat a real validation failure as an absent method', () => {
    // The consequence of getting this wrong is a feature hidden permanently
    // after one malformed call, which is far harder to diagnose than an error.
    expect(isUnsupportedMethodError(err('INVALID_REQUEST', 'name must be a string'))).toBe(false)
    expect(isUnsupportedMethodError(err('INVALID_REQUEST', 'sessionKey is required'))).toBe(false)
  })

  it('never classifies a scope refusal as an absent method', () => {
    // Different fix entirely: re-pair the device, not upgrade the gateway.
    expect(isUnsupportedMethodError(err('MISSING_SCOPE', 'unknown method'))).toBe(false)
  })

  it('tolerates junk', () => {
    expect(isUnsupportedMethodError(null)).toBe(false)
    expect(isUnsupportedMethodError('boom')).toBe(false)
    expect(isUnsupportedMethodError({})).toBe(false)
  })
})

describe('isMissingScopeError', () => {
  it('matches the client pre-flight and the wire form', () => {
    expect(isMissingScopeError(err('MISSING_SCOPE', 'needs operator.admin'))).toBe(true)
    expect(isMissingScopeError(err('INVALID_REQUEST', 'missing scope'))).toBe(true)
  })

  it('ignores unrelated failures', () => {
    expect(isMissingScopeError(err('AGENT_TIMEOUT', 'timed out'))).toBe(false)
  })
})

describe('CapabilityCache', () => {
  it('is optimistic about methods it has never heard of', () => {
    // hello-ok's method list is documented as incomplete, so absence from it
    // must not disable a working feature.
    const cache = new CapabilityCache(['sessions.list'])
    expect(cache.supports('sessions.list')).toBe(true)
    expect(cache.supports('skills.install')).toBe(true)
  })

  it('remembers an unsupported method', () => {
    const cache = new CapabilityCache()
    expect(cache.learnFromError('skills.install', err('INVALID_REQUEST', 'unknown method'))).toBe(
      'unsupported',
    )
    expect(cache.supports('skills.install')).toBe(false)
    expect(cache.get('skills.install')).toBe('unsupported')
  })

  it('remembers a scope refusal separately from an absent method', () => {
    const cache = new CapabilityCache()
    cache.learnFromError('config.get', err('MISSING_SCOPE', 'needs operator.admin'))
    expect(cache.get('config.get')).toBe('forbidden')
  })

  it('does not disable a feature because one call failed at runtime', () => {
    const cache = new CapabilityCache()
    cache.learnFromError('skills.list', err('AGENT_TIMEOUT', 'timed out after 30000ms'))
    expect(cache.supports('skills.list')).toBe(true)
  })

  it('lets a later success override an earlier inference', () => {
    const cache = new CapabilityCache()
    cache.learnFromError('skills.list', err('MISSING_SCOPE', 'missing scope'))
    cache.learnFromSuccess('skills.list')
    expect(cache.get('skills.list')).toBe('available')
  })
})

describe('explainCapability', () => {
  it('distinguishes the two fixes', () => {
    expect(explainCapability('unsupported', 'installing skills')).toMatch(/does not support/)
    expect(explainCapability('forbidden', 'installing skills')).toMatch(/Re-pair/)
    expect(explainCapability('available', 'installing skills')).toBeNull()
  })
})
