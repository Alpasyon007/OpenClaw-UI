/**
 * `@openclaw/conversation` — pure transcript state.
 *
 * No socket, no storage, no React. Everything here is a function of its inputs
 * so the streaming rules can be tested exhaustively, which is the only reliable
 * way to catch the ones that only misbehave on a revised response.
 */
export * from './transcript'
