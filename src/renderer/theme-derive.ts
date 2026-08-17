/**
 * Theme derivation now lives in `@openclaw/theme` so the desktop and the phone
 * derive identical tokens from identical seeds. Re-exported here to keep the
 * renderer's existing import paths working.
 */
export { derivePalette } from '@openclaw/theme'
