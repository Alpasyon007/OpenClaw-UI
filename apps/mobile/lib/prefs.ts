/**
 * Preferences — everything the app remembers that is not a credential.
 *
 * Kept in its own store rather than folded into {@link useApp} because these
 * outlive a connection: the model chosen for a session, whether this device
 * asks for admin scope, whether onboarding has been seen. Rebuilding them from
 * the gateway on every connect is not possible — the gateway does not know
 * them.
 *
 * Writes are fire-and-forget and debounced by nothing: they are small, they are
 * infrequent (a user does not change their model on every keystroke), and a
 * queued write that loses a race with app termination costs one preference.
 */
import { create } from 'zustand'
import { readDoc, writeDoc } from './storage'

const DOC = 'prefs'

/**
 * How tool approvals are handled for a session.
 *
 * `ask` shows the approval sheet and waits — the default, and the only one
 * that keeps a human in the loop.
 *
 * `auto` answers `allow-once` for every request the session raises. This is a
 * real loaded footgun: the phone is then approving shell commands on the
 * gateway host with nobody reading them, and the gateway's own policy is the
 * only thing left between a prompt and a destructive command. It is opt-in,
 * per-session, never the default, never inherited by a new session, and the
 * status bar shows it in the warning colour for as long as it is on.
 */
export type PermissionMode = 'ask' | 'auto'

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto']

export interface SessionPrefs {
  /** Agent to route sends to. Undefined means the gateway's own default. */
  agentId?: string
  /** Model override. Undefined means whatever the session already uses. */
  model?: string
  permissionMode?: PermissionMode
}

interface PrefsState {
  hydrated: boolean

  /**
   * Whether to request `operator.admin` at connect time.
   *
   * Changing this changes the signed scope set, which the gateway treats as a
   * pairing request rather than a reconnect — see `ADMIN_SCOPES`. Nothing here
   * hides that; the settings screen says so before the toggle is flipped.
   */
  adminScope: boolean

  /** Dismissed once the user finishes or skips the first-run flow. */
  onboarded: boolean

  /** Per-session settings, keyed by session key. */
  sessions: Record<string, SessionPrefs>

  hydrate: () => Promise<void>
  setAdminScope: (value: boolean) => void
  setOnboarded: (value: boolean) => void
  setSessionPrefs: (sessionKey: string, patch: Partial<SessionPrefs>) => void
  clearSessionPrefs: (sessionKey: string) => void
}

interface PrefsDoc {
  adminScope?: boolean
  onboarded?: boolean
  sessions?: Record<string, SessionPrefs>
}

const isDoc = (value: unknown): value is PrefsDoc =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const usePrefs = create<PrefsState>((set, get) => ({
  hydrated: false,
  adminScope: false,
  onboarded: false,
  sessions: {},

  async hydrate() {
    const doc = await readDoc<PrefsDoc>(DOC, {}, isDoc)
    set({
      adminScope: doc.adminScope === true,
      onboarded: doc.onboarded === true,
      // Sanitised on the way in: a `permissionMode` from a future build that
      // this one does not implement must not leave a session in a mode nothing
      // honours, which would read as approvals silently going unanswered.
      sessions: sanitiseSessions(doc.sessions),
      hydrated: true,
    })
  },

  setAdminScope(adminScope) {
    set({ adminScope })
    void persist(get())
  },

  setOnboarded(onboarded) {
    set({ onboarded })
    void persist(get())
  },

  setSessionPrefs(sessionKey, patch) {
    set((s) => ({
      sessions: { ...s.sessions, [sessionKey]: { ...s.sessions[sessionKey], ...patch } },
    }))
    void persist(get())
  },

  clearSessionPrefs(sessionKey) {
    set((s) => {
      const next = { ...s.sessions }
      delete next[sessionKey]
      return { sessions: next }
    })
    void persist(get())
  },
}))

function sanitiseSessions(raw: unknown): Record<string, SessionPrefs> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, SessionPrefs> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const prefs: SessionPrefs = {}
    if (typeof v.agentId === 'string' && v.agentId) prefs.agentId = v.agentId
    if (typeof v.model === 'string' && v.model) prefs.model = v.model
    if (v.permissionMode === 'auto' || v.permissionMode === 'ask') {
      prefs.permissionMode = v.permissionMode
    }
    if (Object.keys(prefs).length > 0) out[key] = prefs
  }
  return out
}

async function persist(state: PrefsState): Promise<void> {
  await writeDoc(DOC, {
    adminScope: state.adminScope,
    onboarded: state.onboarded,
    sessions: state.sessions,
  } satisfies PrefsDoc)
}

/**
 * The effective permission mode for a session.
 *
 * Deliberately not inherited from a global default. `auto` is a decision made
 * about one conversation with one set of tools in front of you; carrying it
 * silently into the next session is how it ends up on somewhere it was never
 * considered.
 */
export function permissionModeFor(
  sessions: Record<string, SessionPrefs>,
  sessionKey: string,
): PermissionMode {
  return sessions[sessionKey]?.permissionMode ?? 'ask'
}
