/**
 * App state: one gateway connection, shared by every screen.
 *
 * The client lives at module scope rather than in React state on purpose. It
 * owns a socket and an event subscription, and re-creating it on a re-render
 * would drop the live transcript and re-run the handshake — which the gateway's
 * auth rate limiter (10 attempts a minute, then a five-minute lockout) punishes
 * quickly.
 */
import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import {
  COMPANION_SCOPES,
  M,
  ChatEventSchema,
  ExecApprovalRequestedSchema,
  EVENT_CHAT,
  EVENT_EXEC_APPROVAL_REQUESTED,
  EVENT_EXEC_APPROVAL_RESOLVED,
  EVENT_SESSION_TOOL,
  SessionToolEventSchema,
  type ApprovalDecision,
  type ExecApprovalRequested,
} from '@openclaw/protocol'
import {
  GatewayClient,
  GatewayConnectError,
  type DeviceIdentity,
} from '@openclaw/gateway-client'
import {
  emptyTranscript,
  applyChatEvent,
  applyHistory,
  applyToolEvent,
  addPendingUserMessage,
  settlePendingMessage,
  type TranscriptState,
} from '@openclaw/conversation'
import { loadOrCreateIdentity } from './identity'
import { acquirePushToken, registerPushToken, type PushState } from './push'

const TOKEN_KEY = 'openclaw.gateway.token'
const URL_KEY = 'openclaw.gateway.url'
const NOTIFIER_KEY = 'openclaw.notifier.url'

export const DEFAULT_URL = 'wss://openclaw-gateway-production-091e.up.railway.app'

export type ConnState = 'idle' | 'connecting' | 'ready' | 'pairing' | 'error'

export interface SessionRow {
  key: string
  displayName?: string | null
  model?: string | null
  lastActivityAt?: string | number | null
  hasActiveRun?: boolean
  unread?: boolean
}

interface AppState {
  identity: DeviceIdentity | null
  url: string
  token: string
  conn: ConnState
  connMessage: string
  scopes: readonly string[]
  serverVersion: string | null

  sessions: SessionRow[]
  sessionsLoading: boolean

  /** Transcript per session key. */
  transcripts: Record<string, TranscriptState>
  historyLoading: Record<string, boolean>

  /** Pending tool approvals, newest last. */
  approvals: ExecApprovalRequested[]

  agents: { id: string; name?: string }[]
  models: { id: string; label?: string }[]

  /** Push registration. `null` until it has been attempted. */
  push: PushState | null
  pushDetail: string
  notifierUrl: string

  boot: () => Promise<void>
  setUrl: (url: string) => void
  setToken: (token: string) => void
  setNotifierUrl: (url: string) => void
  /** Acquire an FCM token and register it with the notifier. */
  enablePush: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => void
  refreshSessions: () => Promise<void>
  loadHistory: (sessionKey: string) => Promise<void>
  /** Subscribe to a session so its tool activity streams in. */
  watchSession: (sessionKey: string) => Promise<void>
  unwatchSession: (sessionKey: string) => Promise<void>
  send: (sessionKey: string, text: string) => Promise<void>
  abort: (sessionKey: string) => Promise<void>
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>
  /** Re-fetch pending approvals. Essential after a reconnect or a push wake. */
  replayApprovals: () => Promise<void>
  loadCatalog: () => Promise<void>
}

/** Not in the store: it is not render state, and it must survive re-renders. */
let client: GatewayClient | null = null
let unsubscribers: Array<() => void> = []

export function currentClient(): GatewayClient | null {
  return client
}

export const useApp = create<AppState>((set, get) => ({
  identity: null,
  url: DEFAULT_URL,
  token: '',
  conn: 'idle',
  connMessage: '',
  scopes: [],
  serverVersion: null,

  sessions: [],
  sessionsLoading: false,
  transcripts: {},
  historyLoading: {},
  approvals: [],
  agents: [],
  models: [],
  push: null,
  pushDetail: '',
  notifierUrl: '',

  async boot() {
    const [{ identity }, storedToken, storedUrl, storedNotifier] = await Promise.all([
      loadOrCreateIdentity(),
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(URL_KEY),
      SecureStore.getItemAsync(NOTIFIER_KEY),
    ])
    set({
      identity,
      token: storedToken ?? '',
      url: storedUrl ?? DEFAULT_URL,
      notifierUrl: storedNotifier ?? '',
    })
  },

  setNotifierUrl(url) {
    set({ notifierUrl: url })
    void SecureStore.setItemAsync(NOTIFIER_KEY, url)
  },

  async enablePush() {
    const { identity, notifierUrl } = get()
    if (!identity) return

    const state = await acquirePushToken()
    set({ push: state, pushDetail: state.status === 'registered' ? '' : state.detail })
    if (state.status !== 'registered') return

    if (!notifierUrl.trim()) {
      // The token exists but has nowhere to go. Saying so beats silently
      // looking registered while no notification can ever arrive.
      set({ pushDetail: 'Got a push token, but no notifier URL is configured.' })
      return
    }

    const outcome = await registerPushToken({
      notifierUrl,
      identity,
      pushToken: state.token,
    })
    set({ pushDetail: outcome.detail })
  },

  setUrl(url) {
    set({ url })
    void SecureStore.setItemAsync(URL_KEY, url)
  },

  setToken(token) {
    set({ token })
    // The gateway token authorises tool execution. Keystore only — never
    // AsyncStorage, never a log line.
    void SecureStore.setItemAsync(TOKEN_KEY, token)
  },

  async connect() {
    const { identity, url, token } = get()
    if (!identity) {
      set({ conn: 'error', connMessage: 'no device identity' })
      return
    }

    get().disconnect()
    set({ conn: 'connecting', connMessage: '' })

    const next = new GatewayClient({
      url,
      identity,
      auth: { token: token.trim() },
      scopes: COMPANION_SCOPES,
      client: {
        id: 'openclaw-android',
        version: '0.1.0',
        platform: 'android',
        mode: 'ui',
        deviceFamily: 'Companion',
        displayName: 'OpenClaw Companion',
      },
      handshakeTimeoutMs: 20_000,
    })

    try {
      const hello = await next.connect()
      client = next

      // Live transcript updates. Broadcast to every operator client holding
      // operator.read — there is no per-session subscribe for this.
      unsubscribers.push(
        next.on(EVENT_CHAT, (payload) => {
          const parsed = ChatEventSchema.safeParse(payload)
          if (!parsed.success) return
          const event = parsed.data
          set((s) => ({
            transcripts: {
              ...s.transcripts,
              [event.sessionKey]: applyChatEvent(
                s.transcripts[event.sessionKey] ?? emptyTranscript(),
                event,
              ),
            },
          }))
        }),
      )

      unsubscribers.push(
        next.on(EVENT_EXEC_APPROVAL_REQUESTED, (payload) => {
          const parsed = ExecApprovalRequestedSchema.safeParse(payload)
          if (!parsed.success) return
          set((s) =>
            s.approvals.some((a) => a.id === parsed.data.id)
              ? s
              : { approvals: [...s.approvals, parsed.data] },
          )
        }),
      )

      unsubscribers.push(
        next.on(EVENT_EXEC_APPROVAL_RESOLVED, (payload) => {
          const id = (payload as { id?: string } | null)?.id
          if (!id) return
          set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
        }),
      )

      set({
        conn: 'ready',
        scopes: next.getGrantedScopes(),
        serverVersion: hello.server?.version ?? null,
        connMessage:
          next.getGrantedScopes().length === 0
            ? 'Connected, but no scopes were granted — the device signature did not verify.'
            : '',
      })

      await get().refreshSessions()
      void get().loadCatalog()
      void get().replayApprovals()
    } catch (err) {
      if (err instanceof GatewayConnectError && err.rejection.kind === 'pairing-required') {
        set({
          conn: 'pairing',
          connMessage: 'This device is waiting for approval on the gateway.',
        })
        return
      }
      set({ conn: 'error', connMessage: String(err) })
    }
  },

  disconnect() {
    for (const off of unsubscribers) off()
    unsubscribers = []
    client?.close()
    client = null
    set({ conn: 'idle', scopes: [], approvals: [] })
  },

  async refreshSessions() {
    if (!client) return
    set({ sessionsLoading: true })
    try {
      const result = await client.request<{ sessions?: SessionRow[] }>(M.SESSIONS_LIST, {
        limit: 40,
        offset: 0,
      })
      set({ sessions: result.sessions ?? [] })
    } catch {
      // A failed refresh must never blank a list the user is reading.
    } finally {
      set({ sessionsLoading: false })
    }
  },

  async loadHistory(sessionKey) {
    if (!client) return
    set((s) => ({ historyLoading: { ...s.historyLoading, [sessionKey]: true } }))
    try {
      // `offset: 0` is mandatory, not a default: it selects the newest page AND
      // is what makes the gateway report hasMore/totalMessages at all.
      const result = await client.request<{ messages?: unknown[] }>(M.CHAT_HISTORY, {
        sessionKey,
        limit: 100,
        offset: 0,
      })
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionKey]: applyHistory(
            s.transcripts[sessionKey] ?? emptyTranscript(),
            result.messages ?? [],
          ),
        },
      }))
    } catch {
      // Leave whatever is already on screen.
    } finally {
      set((s) => ({ historyLoading: { ...s.historyLoading, [sessionKey]: false } }))
    }
  },

  async watchSession(sessionKey) {
    if (!client) return
    try {
      await client.request(M.SESSIONS_SUBSCRIBE, { key: sessionKey })
    } catch {
      // A gateway without the method still streams chat; tool cards are the
      // only thing lost, so this must not surface as a failure.
    }
  },

  async unwatchSession(sessionKey) {
    if (!client) return
    try {
      await client.request(M.SESSIONS_UNSUBSCRIBE, { key: sessionKey })
    } catch {
      // Leaving a subscription open costs a little traffic, nothing more.
    }
  },

  async send(sessionKey, text) {
    if (!client) return
    const localId = `local:${Date.now()}:${Math.round(Math.random() * 1e6)}`

    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionKey]: addPendingUserMessage(
          s.transcripts[sessionKey] ?? emptyTranscript(),
          localId,
          text,
          Date.now(),
        ),
      },
    }))

    try {
      // idempotencyKey is required. Reusing it on a retry resumes tracking the
      // original run instead of starting a second one.
      await client.request(
        M.CHAT_SEND,
        { sessionKey, message: text, idempotencyKey: localId },
        { expectFinal: false },
      )
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionKey]: settlePendingMessage(s.transcripts[sessionKey], localId, 'sent'),
        },
      }))
    } catch {
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionKey]: settlePendingMessage(s.transcripts[sessionKey], localId, 'failed'),
        },
      }))
    }
  },

  async abort(sessionKey) {
    const runId = get().transcripts[sessionKey]?.activeRunId
    if (!client || !runId) return
    try {
      await client.request(M.CHAT_ABORT, { sessionKey, runId })
    } catch {
      // Abort is best-effort; the run may already have finished.
    }
  },

  async resolveApproval(id, decision) {
    if (!client) return
    // Optimistic: the card disappears immediately, and the resolved event that
    // follows is a no-op rather than a second update.
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
    try {
      await client.request(M.EXEC_APPROVAL_RESOLVE, { id, decision })
    } catch {
      void get().replayApprovals()
    }
  },

  /** Re-fetch anything still pending — essential after a reconnect. */
  async replayApprovals() {
    if (!client) return
    try {
      const result = await client.request<{ approvals?: unknown[] }>(M.EXEC_APPROVAL_LIST, {})
      const rows = (result.approvals ?? [])
        .map((r) => ExecApprovalRequestedSchema.safeParse(r))
        .filter((r) => r.success)
        .map((r) => r.data)
      set({ approvals: rows })
    } catch {
      // Not fatal: live events still deliver new ones.
    }
  },

  async loadCatalog() {
    if (!client) return
    const [agents, models] = await Promise.allSettled([
      client.request<{ agents?: { id: string; name?: string }[] }>(M.AGENTS_LIST, {}),
      client.request<{ models?: { id: string; label?: string }[] }>(M.MODELS_LIST, {}),
    ])
    set({
      agents: agents.status === 'fulfilled' ? (agents.value.agents ?? []) : [],
      models: models.status === 'fulfilled' ? (models.value.models ?? []) : [],
    })
  },
}))
