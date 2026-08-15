import type { CluiAPI } from '../shared/clui-contract'

// Asset module declarations live in assets.d.ts — a wildcard `declare module`
// only works from a file that is not itself a module, and this one is.

declare global {
  interface Window {
    clui: CluiAPI
  }
}

declare global {
  interface Window {
    /** Diagnostic flag — window tracing. Unset unless the shell installs it. */
    __cluiTraceShell?: boolean
    /** Diagnostic flag — when true, all animation is off. */
    __cluiNoAnim?: boolean
  }
}
export {}
