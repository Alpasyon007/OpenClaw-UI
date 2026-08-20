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
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import {
  CapabilityCache,
  ChatEventSchema,
  CommandsListResultSchema,
  ExecApprovalRequestedSchema,
  EVENT_CHAT,
  EVENT_EXEC_APPROVAL_REQUESTED,
  EVENT_EXEC_APPROVAL_RESOLVED,
  EVENT_SESSION_TOOL,
  M,
  MAX_PAYLOAD_BYTES,
  SessionToolEventSchema,
  fitsPayloadBudget,
  formatBytes,
  isRejectedParamError,
  scopesForMode,
  type ChatAttachment,
  type ApprovalDecision,
  type ExecApprovalRequested,
  type GatewayCommand,
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
import { usePrefs, permissionModeFor } from './prefs'
import { toChatAttachment, type DraftAttachment } from './attachments'

const TOKEN_KEY = 'openclaw.gateway.token'
const URL_KEY = 'openclaw.gateway.url'
const NOTIFIER_KEY = 'openclaw.notifier.url'

export const DEFAULT_URL = 'wss://openclaw-gateway-production-091e.up.railway.app'

/**
 * The app's version, read from app.json rather than written out again.
 *
 * It goes to the gateway on every connect and shows up in `openclaw devices
 * list`, so a stale literal here means the operator is told the wrong build is
 * connected — which is exactly the thing they would be checking.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0'

export type ConnState = 'idle' | 'connecting' | 'ready' | 'pairing' | 'error'

export interface SessionRow {
  key: string
  displayName?: string | null
  model?: string | null
  lastActivityAt?: string | number | null
  hasActiveRun?: boolean
  unread?: boolean
}

/**
 * What the gateway knows about a session that the transcript does not.
 *
 * Fetched on demand rather than with the session list: the list is 40 rows and
 * this is one request each, which on a phone radio is the difference between a
 * list that appears immediately and one that does not.
 */
export interface SessionMeta {
  cwd?: string | null
  model?: string | null
  agentId?: string | null
  status?: string | null
  /** Set when a fetch failed, so the status bar can stay quiet about it. */
  unavailable?: boolean
}

export interface AgentOption {
  id: string
  name?: string
}

export interface ModelOption {
  id: string
  label?: string
}

/** Result of a send, so the composer can say what happened. */
export type SendOutcome =
  | { ok: true; modelIgnored?: boolean }
  | { ok: false; error: string }

interface AppState {
  identity: DeviceIdentity | null
  url: string
  token: string
  conn: ConnState
  connMessage: string
  scopes: readonly string[]
  serverVersion: string | null
  /** Live cap from `hello-ok.policy`, or the documented default. */
  maxPayload: number

  sessions: SessionRow[]
  sessionsLoading: boolean

  /** Transcript per session key. */
  transcripts: Record<string, TranscriptState>
  historyLoading: Record<string, boolean>
  sessionMeta: Record<string, SessionMeta>

  /** Pending tool approvals, newest last. */
  approvals: ExecApprovalRequested[]

  agents: AgentOption[]
  models: ModelOption[]
  commands: GatewayCommand[]

  /** Push registration. `null` until it has been attempted. */
  push: PushState | null
  pushDetail: string
  notifierUrl: string

  boot: () => Promise<void>
  setUrl: (url: string) => void
  setToken: (token: string) => void
  setNotifierUrl: (url: string) => void
  enablePush: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => void
  refreshSessions: () => Promise<void>
  loadHistory: (sessionKey: string) => Promise<void>
  loadSessionMeta: (sessionKey: string) => Promise<void>
  watchSession: (sessionKey: string) => Promise<void>
  unwatchSession: (sessionKey: string) => Promise<void>
  send: (
    sessionKey: string,
    text: string,
    attachments?: readonly DraftAttachment[],
  ) => Promise<SendOutcome>
  abort: (sessionKey: string) => Promise<void>
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>
  replayApprovals: () => Promise<void>
  loadCatalog: () => Promise<void>
  /** True unless the gateway has already refused this method. */
  supports: (method: string) => boolean
}

/** Not in the store: none of this is render state, and it must survive renders. */
let client: GatewayClient | null = null
let unsubscribers: Array<() => void> = []
let capabilities = new CapabilityCache()

export function currentClient(): GatewayClient | null {
  return client
}

export function currentCapabilities(): CapabilityCache {
  return capabilities
}

/**
 * Issue a request, recording what a failure taught us about the gateway.
 *
 * Every call that might hit a method an older gateway lacks goes through this
 * rather than `client.request` directly, so a screen can ask
 * {@link AppState.supports} and hide an affordance instead of offering a button
 * that fails every time it is pressed.
 */
export async function tracked<T>(
  method: string,
  params?: unknown,
  options?: { expectFinal?: boolean; timeoutMs?: number },
): Promise<T> {
  if (!client) throw new Error('not connected')
  try {
    const result = await client.request<T>(method, params, options)
    capabilities.learnFromSuccess(method)
    return result
  } catch (err) {
    capabilities.learnFromError(method, err)
    throw err
  }
}

export const useApp = create<AppState>((set, get) => ({
  identity: null,
  url: DEFAULT_URL,
  token: '',
  conn: 'idle',
  connMessage: '',
  scopes: [],
  serverVersion: null,
  maxPayload: MAX_PAYLOAD_BYTES,

  sessions: [],
  sessionsLoading: false,
  transcripts: {},
  historyLoading: {},
  sessionMeta: {},
  approvals: [],
  agents: [],
  models: [],
  commands: [],
  push: null,
  pushDetail: '',
  notifierUrl: '',

  supports: (method) => capabilities.supports(method),

  async boot() {
    const [{ identity }, storedToken, storedUrl, storedNotifier] = await Promise.all([
      loadOrCreateIdentity(),
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(URL_KEY),
      SecureStore.getItemAsync(NOTIFIER_KEY),
      // Preferences decide which scopes the handshake asks for, so they have to
      // be loaded before any connect can happen — not alongside it.
      usePrefs.getState().hydrate(),
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

    // Scope set comes from preferences: asking for admin is a user decision,
    // and it changes the *signed* scopes, which re-pins the device.
    const scopes = scopesForMode(usePrefs.getState().adminScope)

    const next = new GatewayClient({
      url,
      identity,
      auth: { token: token.trim() },
      scopes,
      client: {
        id: 'openclaw-android',
        version: APP_VERSION,
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
      capabilities = new CapabilityCache(hello.features?.methods ?? [])

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

      // Tool activity. Unlike `chat`, this reaches only clients that called
      // `sessions.subscribe` for the key — see `watchSession`. Without this
      // handler the subscribe still succeeds and the events are simply
      // dropped, which looks exactly like a gateway that sends none.
      unsubscribers.push(
        next.on(EVENT_SESSION_TOOL, (payload) => {
          const parsed = SessionToolEventSchema.safeParse(payload)
          if (!parsed.success) return
          const event = parsed.data
          const key = event.sessionKey
          if (!key) return
          set((s) => ({
            transcripts: {
              ...s.transcripts,
              [key]: applyToolEvent(s.transcripts[key] ?? emptyTranscript(), event),
            },
          }))
        }),
      )

      unsubscribers.push(
        next.on(EVENT_EXEC_APPROVAL_REQUESTED, (payload) => {
          const parsed = ExecApprovalRequestedSchema.safeParse(payload)
          if (!parsed.success) return
          const approval = parsed.data
          set((s) =>
            s.approvals.some((a) => a.id === approval.id)
              ? s
              : { approvals: [...s.approvals, approval] },
          )
          maybeAutoApprove(approval)
        }),
      )

      unsubscribers.push(
        next.on(EVENT_EXEC_APPROVAL_RESOLVED, (payload) => {
          const id = (payload as { id?: string } | null)?.id
          if (!id) return
          set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
        }),
      )

      const granted = next.getGrantedScopes()
      set({
        conn: 'ready',
        scopes: granted,
        serverVersion: hello.server?.version ?? null,
        maxPayload: hello.policy?.maxPayload ?? MAX_PAYLOAD_BYTES,
        connMessage:
          granted.length === 0
            ? 'Connected, but no scopes were granted — the device signature did not verify.'
            : '',
      })

      await get().refreshSessions()
      void get().loadCatalog()
      void get().replayApprovals()
    } catch (err) {
      if (err instanceof GatewayConnectError && err.rejection.kind === 'pairing-required') {
        // `scope-upgrade` is the reason a user sees after turning admin on, and
        // naming it is the difference between "I broke it" and "I need to
        // approve this again".
        const reason = err.rejection.reason
        set({
          conn: 'pairing',
          connMessage:
            reason === 'scope-upgrade'
              ? 'This device asked for a wider scope. Approve it again on the gateway with `openclaw devices approve`.'
              : 'This device is waiting for approval on the gateway.',
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
    capabilities = new CapabilityCache()
    set({ conn: 'idle', scopes: [], approvals: [] })
  },

  async refreshSessions() {
    if (!client) return
    set({ sessionsLoading: true })
    try {
      const result = await tracked<{ sessions?: SessionRow[] }>(M.SESSIONS_LIST, {
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
      const result = await tracked<{ messages?: unknown[] }>(M.CHAT_HISTORY, {
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

  /**
   * Fetch the session's own metadata — working directory, model, agent.
   *
   * Failure is recorded as `unavailable` rather than left absent, so the status
   * bar can distinguish "not fetched yet" from "this gateway will not tell us"
   * and stop showing a placeholder that never resolves.
   */
  async loadSessionMeta(sessionKey) {
    if (!client) return
    try {
      const result = await tracked<Record<string, unknown>>(M.SESSIONS_GET, {
        key: sessionKey,
      })
      // The payload is either the session or `{session: …}` depending on build.
      const raw = (result.session ?? result) as Record<string, unknown>
      set((s) => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: {
            cwd: readString(raw, 'cwd', 'workingDirectory', 'workdir'),
            model: readString(raw, 'model', 'modelId'),
            agentId: readString(raw, 'agentId', 'agent'),
            status: readString(raw, 'status', 'state'),
          },
        },
      }))
    } catch {
      set((s) => ({
        sessionMeta: { ...s.sessionMeta, [sessionKey]: { unavailable: true } },
      }))
    }
  },

  async watchSession(sessionKey) {
    if (!client) return
    try {
      await tracked(M.SESSIONS_SUBSCRIBE, { key: sessionKey })
    } catch {
      // A gateway without the method still streams chat; tool cards are the
      // only thing lost, so this must not surface as a failure.
    }
  },

  async unwatchSession(sessionKey) {
    if (!client) return
    try {
      await tracked(M.SESSIONS_UNSUBSCRIBE, { key: sessionKey })
    } catch {
      // Leaving a subscription open costs a little traffic, nothing more.
    }
  },

  async send(sessionKey, text, attachments = []) {
    if (!client) return { ok: false, error: 'Not connected.' }

    const prefs = usePrefs.getState().sessions[sessionKey] ?? {}
    const wire: ChatAttachment[] = attachments.map(toChatAttachment)

    // Checked here rather than at the socket, because the gateway does not
    // reject an oversized frame — it closes the connection. A send that would
    // do that must fail locally with something a user can act on.
    const budget = fitsPayloadBudget(wire, byteLength(text), get().maxPayload)
    if (!budget.ok) {
      return {
        ok: false,
        error: `That is ${formatBytes(budget.totalBytes)}, over this gateway's ${formatBytes(
          budget.limitBytes,
        )} message limit. Remove an attachment and try again.`,
      }
    }

    const localId = `local:${Date.now()}:${Math.round(Math.random() * 1e6)}`
    // The transcript row records that files went with the message; the payload
    // itself is not kept, because holding several megabytes of base64 per image
    // for the life of the session buys nothing that re-renders.
    const body = attachments.length
      ? `${text}${text ? '\n\n' : ''}${attachments.map((a) => `📎 ${a.name}`).join('\n')}`
      : text

    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionKey]: addPendingUserMessage(
          s.transcripts[sessionKey] ?? emptyTranscript(),
          localId,
          body,
          Date.now(),
        ),
      },
    }))

    const base = {
      sessionKey,
      message: text,
      idempotencyKey: localId,
      ...(prefs.agentId ? { agentId: prefs.agentId } : {}),
      ...(wire.length ? { attachments: wire } : {}),
    }

    const settle = (outcome: 'sent' | 'failed'): void => {
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionKey]: settlePendingMessage(s.transcripts[sessionKey], localId, outcome),
        },
      }))
    }

    try {
      // idempotencyKey is required. Reusing it on a retry resumes tracking the
      // original run instead of starting a second one — which is exactly what
      // the model-rejection retry below relies on.
      await tracked(
        M.CHAT_SEND,
        prefs.model ? { ...base, model: prefs.model } : base,
        { expectFinal: false },
      )
      settle('sent')
      return { ok: true }
    } catch (err) {
      // A gateway that validates `chat.send` strictly rejects the `model` field
      // it does not know. Without this the user's message is simply lost, and
      // the only visible connection to the model they picked is that sending
      // stopped working.
      if (prefs.model && isRejectedParamError(err, 'model')) {
        try {
          await tracked(M.CHAT_SEND, base, { expectFinal: false })
          settle('sent')
          return { ok: true, modelIgnored: true }
        } catch (retryErr) {
          settle('failed')
          return { ok: false, error: describe(retryErr) }
        }
      }
      settle('failed')
      return { ok: false, error: describe(err) }
    }
  },

  async abort(sessionKey) {
    const runId = get().transcripts[sessionKey]?.activeRunId
    if (!client || !runId) return
    try {
      await tracked(M.CHAT_ABORT, { sessionKey, runId })
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
      await tracked(M.EXEC_APPROVAL_RESOLVE, { id, decision })
    } catch {
      void get().replayApprovals()
    }
  },

  /** Re-fetch anything still pending — essential after a reconnect. */
  async replayApprovals() {
    if (!client) return
    try {
      const result = await tracked<{ approvals?: unknown[] }>(M.EXEC_APPROVAL_LIST, {})
      const rows = (result.approvals ?? [])
        .map((r) => ExecApprovalRequestedSchema.safeParse(r))
        .filter((r) => r.success)
        .map((r) => r.data)
      set({ approvals: rows })
      // Replayed approvals still honour an auto session — otherwise a reconnect
      // silently reverts the mode the user set and the run stalls waiting on a
      // sheet nobody is looking at.
      for (const row of rows) maybeAutoApprove(row)
    } catch {
      // Not fatal: live events still deliver new ones.
    }
  },

  async loadCatalog() {
    if (!client) return
    const [agents, models, commands] = await Promise.allSettled([
      tracked<{ agents?: AgentOption[] }>(M.AGENTS_LIST, {}),
      tracked<{ models?: ModelOption[] }>(M.MODELS_LIST, {}),
      tracked<unknown>(M.COMMANDS_LIST, {}),
    ])

    const parsedCommands =
      commands.status === 'fulfilled'
        ? CommandsListResultSchema.safeParse(commands.value)
        : null

    set({
      agents: agents.status === 'fulfilled' ? (agents.value.agents ?? []) : [],
      models: models.status === 'fulfilled' ? (models.value.models ?? []) : [],
      commands: parsedCommands?.success ? parsedCommands.data.commands : [],
    })
  },
}))

/**
 * Answer an approval automatically when its session is in `auto` mode.
 *
 * `allow-once` and never `allow-always`: an unattended approval should not also
 * write durable trust for the command on the gateway, which would outlive both
 * the session and the mode that caused it.
 *
 * A request with no `sessionKey` is left alone. Those are global, they cannot
 * be attributed to the session the user opted in for, and auto-answering one
 * would apply a per-session decision to work the user never saw.
 */
function maybeAutoApprove(approval: ExecApprovalRequested): void {
  const sessionKey = approval.request.sessionKey
  if (!sessionKey) return
  if (permissionModeFor(usePrefs.getState().sessions, sessionKey) !== 'auto') return
  void useApp.getState().resolveApproval(approval.id, 'allow-once')
}

function readString(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/**
 * UTF-8 byte length.
 *
 * `String.length` counts UTF-16 units and undercounts every non-ASCII prompt —
 * which is exactly the case where a message is near the payload limit for
 * reasons the user cannot see.
 */
function byteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
