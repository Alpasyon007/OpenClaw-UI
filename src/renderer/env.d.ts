import type { CluiAPI } from '../preload/index'

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    clui: CluiAPI
  }
}

declare global {
  interface Window {
    /** Diagnostic flag set by the preload when window tracing is enabled. */
    __cluiTraceShell?: boolean
    /** Diagnostic flag set by the preload when CLUI_NO_ANIM=1 — all animation off. */
    __cluiNoAnim?: boolean
  }
}
export {}
