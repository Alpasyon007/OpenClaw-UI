/**
 * Ambient declarations for assets Vite resolves to a URL string.
 *
 * This file must stay free of top-level `import`/`export`. A wildcard
 * `declare module '*.mp3'` inside a *module* is parsed as an augmentation of a
 * module literally named `*.mp3` rather than as a global pattern, which is why
 * the copy that used to live in env.d.ts never applied and
 * `import notificationSrc from '…/notification.mp3'` failed to resolve.
 */

declare module '*.mp3' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}
