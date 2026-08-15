import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { installCluiStub, resetCluiStub } from '../helpers/clui-stub'

/**
 * Renderer test environment.
 *
 * jsdom is missing several APIs this app uses unconditionally during render.
 * Stubbing them here rather than in each test keeps the failure mode honest: a
 * component that reaches for something genuinely absent still throws.
 */

// framer-motion and the scroll-pinning in ConversationView both drive rAF.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number)
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id))
}

// jsdom implements neither observer. Several panels construct one on mount.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver

// jsdom throws "not implemented" on these rather than no-oping.
Element.prototype.scrollIntoView ??= function () {}
if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {}
}

// The theme store reads the OS preference on first render.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// The notification chime is fire-and-forget; jsdom cannot decode audio.
window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
window.HTMLMediaElement.prototype.pause = vi.fn()

beforeEach(() => {
  installCluiStub()
})

afterEach(() => {
  cleanup()
  resetCluiStub()
})
