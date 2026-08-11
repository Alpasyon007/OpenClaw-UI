import type { CluiAPI } from '../shared/clui-contract'

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
    /** Diagnostic flag — window tracing. Unset unless the shell installs it. */
    __cluiTraceShell?: boolean
    /** Diagnostic flag — when true, all animation is off. */
    __cluiNoAnim?: boolean
  }
}
export {}
