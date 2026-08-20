import { create } from 'zustand'
import type { TabStatus, NormalizedEvent, EnrichedError, Message, TabState, Attachment, CatalogPlugin, PluginStatus, SessionLoadMessage, GatewaySessionMeta } from '../../shared/types'
import { useThemeStore } from '../theme'
import notificationSrc from '../../../resources/notification.mp3'

export interface OpenclawModelOption {
  id: string
  label: string
  provider: string
}

function normalizeModelId(modelId: string): string {
  // Claude sometimes appends context window hints like "[1m]" to model IDs.
  return modelId.replace(/\[[^\]]+\]/g, '').trim()
}

export function getModelDisplayLabel(modelId: string): string {
  const normalizedId = normalizeModelId(modelId)
  const withPrefix = normalizedId.includes('/') ? normalizedId : normalizedId
  const parts = withPrefix.split('/')
  if (parts.length >= 2) return parts.slice(1).join('/')
  return normalizedId
}

/** Guards against stacking a second onStartInfo listener on a re-init. */
let startInfoSubscribed = false

/**
 * How often the app checks for a CLI update on its own.
 *
 * `update check` is a ~4s CLI spawn that also hits the network. Running it on
 * every launch — which is what the old auto-call did — put a heavyweight
 * process on the critical path of the launcher appearing, to answer a question
 * whose answer changes maybe weekly. The "Check Update" button is unaffected.
 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const UPDATE_CHECK_STAMP_KEY = 'openclaw-last-update-check'

// ─── Store ───

interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
  cliBinary: string
  cliCommand: string
  authSupported: boolean
  mcpSupported: boolean
}

interface State {
  tabs: TabState[]
  activeTabId: string
  /** Global expand/collapse — user-controlled, not per-tab */
  isExpanded: boolean
  /** Global info fetched on startup (not per-session) */
  staticInfo: StaticInfo | null
  /** User's preferred model override (null = use default) */
  preferredModel: string | null
  openclawModels: OpenclawModelOption[]
  activeProvider: string | null
  currentOpenclawModel: string | null
  /** True while a gateway model query or write is in flight (each is ~9s) */
  openclawModelsLoading: boolean
  /** Last model load/apply failure, surfaced instead of silently ignored */
  openclawModelError: string | null
  openclawUpdateInfo: string | null
  openclawUpdateBusy: boolean
  /** Global permission mode: 'ask' shows cards, 'auto' auto-approves all tool calls */
  permissionMode: 'ask' | 'auto'

  // Marketplace state
  marketplaceOpen: boolean
  controlCenterOpen: boolean
  controlCenterTab: 'agents' | 'settings' | 'appearance'
  skillBuilderOpen: boolean
  marketplaceCatalog: CatalogPlugin[]
  marketplaceLoading: boolean
  marketplaceError: string | null
  marketplaceInstalledNames: string[]
  marketplacePluginStates: Record<string, PluginStatus>
  marketplaceSearch: string
  marketplaceFilter: string

  // Actions
  initStaticInfo: () => Promise<void>
  setPreferredModel: (model: string | null) => void
  refreshOpenclawModels: () => Promise<void>
  setOpenclawModel: (provider: string, model: string) => Promise<void>
  checkOpenclawUpdate: () => Promise<void>
  /** Update check, but at most once a day. Cheap to call on every launch. */
  maybeCheckOpenclawUpdate: () => Promise<void>
  runOpenclawUpgrade: () => Promise<void>
  setPermissionMode: (mode: 'ask' | 'auto') => void
  createTab: () => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  clearTab: () => void
  toggleExpanded: () => void
  toggleMarketplace: () => void
  toggleSkillBuilder: () => void
  openSkillBuilder: () => void
  closeSkillBuilder: () => void
  openControlCenter: (tab?: 'agents' | 'settings' | 'appearance') => void
  closeControlCenter: () => void
  setControlCenterTab: (tab: 'agents' | 'settings' | 'appearance') => void
  closeMarketplace: () => void
  closeAuxPanels: () => void
  loadMarketplace: (forceRefresh?: boolean) => Promise<void>
  setMarketplaceSearch: (query: string) => void
  setMarketplaceFilter: (filter: string) => void
  installMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  uninstallMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  buildYourOwn: () => void
  resumeSession: (sessionId: string, title?: string, projectPath?: string) => Promise<string>
  /** Reattach a new tab to a session that lives on the gateway. */
  resumeGatewaySession: (session: GatewaySessionMeta, title?: string) => Promise<string>
  addSystemMessage: (content: string) => void
  sendMessage: (prompt: string, projectPath?: string) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  addAttachments: (attachments: Attachment[]) => void
  removeAttachment: (attachmentId: string) => void
  clearAttachments: () => void
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void
  handleStatusChange: (tabId: string, newStatus: string, oldStatus: string) => void
  handleError: (tabId: string, error: EnrichedError) => void
}

let msgCounter = 0
const nextMsgId = () => `msg-${++msgCounter}`

/**
 * Index of the tool message still awaiting its result, or -1.
 *
 * Tool events carry a block index that is scoped to one assistant message, not
 * to the transcript, so the only reliable association is "the most recent tool
 * row that has not completed".
 */
function lastRunningToolIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool' && messages[i].toolStatus === 'running') return i
  }
  return -1
}

// ─── Notification sound (plays when task completes while window is hidden) ───
const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

async function playNotificationIfHidden(): Promise<void> {
  if (!useThemeStore.getState().soundEnabled) return
  try {
    const visible = await window.clui.isVisible()
    if (!visible) {
      notificationAudio.currentTime = 0
      notificationAudio.play().catch(() => {})
    }
  } catch {}
}

async function showCompletionNotificationIfHidden(title: string, body: string): Promise<void> {
  try {
    const visible = await window.clui.isVisible()
    if (visible) return
    if (typeof Notification === 'undefined') return

    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    if (Notification.permission !== 'granted') return

    const notification = new Notification(title, {
      body,
      silent: true, // sound is handled via notification.mp3 to keep consistent UX
    })
    notification.onclick = () => {
      try { window.focus() } catch {}
    }
  } catch {}
}

function latestAssistantPreview(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.content.trim().length > 0) {
      const oneLine = msg.content.replace(/\s+/g, ' ').trim()
      return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine
    }
  }
  return 'Response completed.'
}

function makeLocalTab(): TabState {
  return {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    status: 'idle',
    activeRequestId: null,
    hasUnread: false,
    currentActivity: '',
    lastEventAt: Date.now(),
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    messages: [],
    title: 'New Tab',
    lastResult: null,
    sessionModel: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    gatewayState: 'unknown',
    sessionOrigin: null,
  }
}

const initialTab = makeLocalTab()

export const useSessionStore = create<State>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  isExpanded: false,
  staticInfo: null,
  preferredModel: null,
  openclawModels: [],
  activeProvider: null,
  currentOpenclawModel: null,
  openclawModelsLoading: false,
  openclawModelError: null,
  openclawUpdateInfo: null,
  openclawUpdateBusy: false,
  permissionMode: 'ask',

  // Marketplace
  marketplaceOpen: false,
  controlCenterOpen: false,
  controlCenterTab: 'agents',
  skillBuilderOpen: false,
  marketplaceCatalog: [],
  marketplaceLoading: false,
  marketplaceError: null,
  marketplaceInstalledNames: [],
  marketplacePluginStates: {},
  marketplaceSearch: '',
  marketplaceFilter: 'All',

  initStaticInfo: async () => {
    // The CLI-derived half of this can arrive twice: once from cache when the
    // handler answers, and again over onStartInfo after a background refresh.
    // Both land here.
    const apply = (result: Awaited<ReturnType<typeof window.clui.start>>) => {
      set({
        staticInfo: {
          version: result.version || 'unknown',
          email: result.auth?.email || null,
          subscriptionType: result.auth?.subscriptionType || null,
          projectPath: result.projectPath || '~',
          homePath: result.homePath || '~',
          cliBinary: result.cliBinary || 'openclaw',
          cliCommand: result.cliCommand || 'openclaw',
          authSupported: result.authSupported !== false,
          mcpSupported: result.mcpSupported !== false,
        },
      })
    }

    if (!startInfoSubscribed) {
      startInfoSubscribed = true
      window.clui.onStartInfo(apply)
    }

    try {
      apply(await window.clui.start())
      void get().refreshOpenclawModels()
    } catch {}
  },

  setPreferredModel: (model) => {
    set({ preferredModel: model })
  },

  refreshOpenclawModels: async () => {
    set({ openclawModelsLoading: true })
    try {
      const info = await window.clui.openclawModelInfo()
      if (!info.ok) {
        set({
          openclawModelsLoading: false,
          openclawModelError: (info as { error?: string }).error || 'Could not load models',
        })
        return
      }
      // Keep every provider's models, not just the active one — restricting
      // the list to the current provider makes switching providers impossible.
      const options: OpenclawModelOption[] = []
      for (const p of info.providers) {
        for (const m of p.models) {
          options.push({ id: m.id, label: m.name || m.id, provider: p.id })
        }
      }
      const activeProvider = info.provider || info.providers[0]?.id || null
      set({
        openclawModels: options,
        activeProvider,
        currentOpenclawModel: info.model || null,
        preferredModel: info.model || null,
        openclawModelsLoading: false,
        openclawModelError: options.length === 0 ? 'No models available on this gateway' : null,
      })
    } catch {
      set({ openclawModelsLoading: false, openclawModelError: 'Could not load models' })
    }
  },

  setOpenclawModel: async (provider, model) => {
    set({ openclawModelsLoading: true, openclawModelError: null })
    try {
      const res = await window.clui.openclawSetModel(provider, model)
      if (!res.ok) {
        // Previously swallowed: the user clicked Apply and nothing happened,
        // with no way to tell whether it worked.
        set({ openclawModelsLoading: false, openclawModelError: res.error || 'Failed to apply model' })
        return
      }
      set({
        currentOpenclawModel: model,
        preferredModel: model,
        activeProvider: provider,
        openclawModelsLoading: false,
        openclawModelError: null,
      })
    } catch {
      set({ openclawModelsLoading: false, openclawModelError: 'Failed to apply model' })
    }
  },

  maybeCheckOpenclawUpdate: async () => {
    const last = Number(localStorage.getItem(UPDATE_CHECK_STAMP_KEY) || 0)
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return
    localStorage.setItem(UPDATE_CHECK_STAMP_KEY, String(Date.now()))
    await get().checkOpenclawUpdate()
  },

  checkOpenclawUpdate: async () => {
    localStorage.setItem(UPDATE_CHECK_STAMP_KEY, String(Date.now()))
    set({ openclawUpdateBusy: true })
    try {
      const res = await window.clui.openclawRun('update_check')
      set({
        openclawUpdateInfo: res.ok
          ? (res.output || 'OpenClaw update check completed.')
          : (res.error || res.output || 'OpenClaw update check failed.'),
        openclawUpdateBusy: false,
      })
    } catch {
      set({
        openclawUpdateInfo: 'OpenClaw update check failed.',
        openclawUpdateBusy: false,
      })
    }
  },

  runOpenclawUpgrade: async () => {
    set({ openclawUpdateBusy: true })
    try {
      const res = await window.clui.openclawRun('update_upgrade')
      set({
        openclawUpdateInfo: res.ok
          ? (res.output || 'OpenClaw upgrade completed.')
          : (res.error || res.output || 'OpenClaw upgrade failed.'),
        openclawUpdateBusy: false,
      })
    } catch {
      set({
        openclawUpdateInfo: 'OpenClaw upgrade failed.',
        openclawUpdateBusy: false,
      })
    }
  },

  setPermissionMode: (mode) => {
    set({ permissionMode: mode })
    window.clui.setPermissionMode(mode)
  },

  createTab: async () => {
    const homeDir = get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.clui.createTab()
      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: homeDir,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.workingDirectory = homeDir
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      return tab.id
    }
  },

  selectTab: (tabId) => {
    const s = get()
    if (tabId === s.activeTabId) {
      // Clicking the already-active tab: toggle global expand/collapse
      const willExpand = !s.isExpanded
      set((prev) => ({
        isExpanded: willExpand,
        marketplaceOpen: false,
        // Expanding = reading: clear unread flag
        tabs: willExpand
          ? prev.tabs.map((t) => t.id === tabId ? { ...t, hasUnread: false } : t)
          : prev.tabs,
      }))
    } else {
      // Switching to a different tab: mark as read
      set((prev) => ({
        activeTabId: tabId,
        marketplaceOpen: false,
        tabs: prev.tabs.map((t) =>
          t.id === tabId ? { ...t, hasUnread: false } : t
        ),
      }))
    }
  },

  toggleExpanded: () => {
    const { activeTabId, isExpanded } = get()
    const willExpand = !isExpanded
    set((s) => ({
      isExpanded: willExpand,
      marketplaceOpen: false,
      // Expanding = reading: clear unread flag for the active tab
      tabs: willExpand
        ? s.tabs.map((t) => t.id === activeTabId ? { ...t, hasUnread: false } : t)
        : s.tabs,
    }))
  },

  toggleMarketplace: () => {
    const s = get()
    if (s.marketplaceOpen) {
      set({ marketplaceOpen: false })
    } else {
      set({ isExpanded: false, marketplaceOpen: true, controlCenterOpen: false, skillBuilderOpen: false })
      void get().loadMarketplace()
    }
  },

  toggleSkillBuilder: () => {
    const s = get()
    if (s.skillBuilderOpen) {
      set({ skillBuilderOpen: false })
    } else {
      set({ isExpanded: false, skillBuilderOpen: true, marketplaceOpen: false, controlCenterOpen: false })
    }
  },

  openSkillBuilder: () => {
    set({ isExpanded: false, skillBuilderOpen: true, marketplaceOpen: false, controlCenterOpen: false })
  },

  closeSkillBuilder: () => {
    set({ skillBuilderOpen: false })
  },

  openControlCenter: (tab = 'agents') => {
    set({ isExpanded: false, marketplaceOpen: false, skillBuilderOpen: false, controlCenterOpen: true, controlCenterTab: tab })
  },

  closeControlCenter: () => {
    set({ controlCenterOpen: false })
  },

  setControlCenterTab: (tab) => {
    set({ controlCenterTab: tab })
  },

  closeMarketplace: () => {
    set({ marketplaceOpen: false })
  },

  closeAuxPanels: () => {
    // Called on every window show. Setting state unconditionally would notify
    // every subscriber and re-render the shell while the entrance animation is
    // running, so bail out when there is nothing open to close.
    const s = get()
    if (!s.marketplaceOpen && !s.controlCenterOpen && !s.skillBuilderOpen) return
    set({ marketplaceOpen: false, controlCenterOpen: false, skillBuilderOpen: false })
  },

  loadMarketplace: async (forceRefresh) => {
    set({ marketplaceLoading: true, marketplaceError: null })
    try {
      const existingClawhub = get().marketplaceInstalledNames.filter((n) => n.startsWith('clawhub:'))
      const [catalog, installed] = await Promise.all([
        window.clui.fetchMarketplace(forceRefresh),
        window.clui.listInstalledPlugins(),
      ])
      if (catalog.error && catalog.plugins.length === 0) {
        set({ marketplaceError: catalog.error, marketplaceLoading: false })
        return
      }
      const installedSet = new Set([...installed, ...existingClawhub].map((n) => n.toLowerCase()))
      const pluginStates: Record<string, PluginStatus> = {}
      for (const p of catalog.plugins) {
        // Gateway entries are, by construction, things the runtime already has.
        // Settled by id rather than by name so a same-named community skill in
        // the browsable catalogue can never be mistaken for one of them.
        if (p.installMode === 'gateway') {
          pluginStates[p.id] = 'installed'
          continue
        }
        if (p.installMode === 'clawhub') {
          pluginStates[p.id] = installedSet.has(`clawhub:${p.installName}`.toLowerCase()) ? 'installed' : 'not_installed'
          continue
        }
        // For SKILL.md skills: match individual name against ~/.claude/skills/ dirs
        // For CLI plugins: match installName or "installName@marketplace" against installed_plugins.json
        const repoSlug = (p.repo || '').split('/').pop() || ''
        const candidates = p.isSkillMd
          ? [p.installName]
          : [
            p.installName,
            `${p.installName}@${p.marketplace}`,
            ...(repoSlug ? [`${p.installName}@${repoSlug}`] : []),
          ]
        const isInstalled = candidates.some((c) => installedSet.has(c.toLowerCase()))
        pluginStates[p.id] = isInstalled ? 'installed' : 'not_installed'
      }
      set({
        marketplaceCatalog: catalog.plugins,
        marketplaceInstalledNames: Array.from(new Set([...installed, ...existingClawhub])),
        marketplacePluginStates: pluginStates,
        marketplaceLoading: false,
      })
    } catch (err: unknown) {
      set({
        marketplaceError: err instanceof Error ? err.message : String(err),
        marketplaceLoading: false,
      })
    }
  },

  setMarketplaceSearch: (query) => {
    set({ marketplaceSearch: query })
  },

  setMarketplaceFilter: (filter) => {
    set({ marketplaceFilter: filter })
  },

  installMarketplacePlugin: async (plugin) => {
    const state = get()
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId)
    if (activeTab && (activeTab.status === 'running' || activeTab.status === 'connecting')) {
      get().addSystemMessage('OpenClaw is busy. Wait for the current response, then tap Install again.')
      return
    }

    const marketplaceSlug = (plugin.repo || '').split('/').pop() || plugin.marketplace
    const command = plugin.isSkillMd
      ? `Install skill ${plugin.installName} from ${plugin.repo}/${plugin.sourcePath || `skills/${plugin.installName}`}`
      : `openclaw plugin install ${plugin.installName}@${marketplaceSlug}`

    let prompt = [
      `Install this skill/plugin for me: ${plugin.name} (${plugin.installName}).`,
      `Run command: ${command}.`,
      'After installing, verify it is available and then summarize the result.',
    ].join('\n')

    if (plugin.installMode === 'clawhub') {
      const inspect = await window.clui.openclawRun(`clawhub_inspect:${plugin.installName}`)
      const searchQuery = (plugin.name || plugin.installName).replace(/-/g, ' ')
      if (inspect.ok) {
        prompt = `${plugin.name} is a skill i want to install, check clawhub and see if you can install this skill or tell me if theres any simmilar skill on claw hub. The verified slug is ${plugin.installName}. If available, install it and confirm with clawhub list.`
      } else {
        let search = await window.clui.openclawRun(`clawhub_search:${searchQuery}`)
        if (!search.ok || !(search.output || '').trim()) {
          search = await window.clui.openclawRun(`clawhub_search:${plugin.installName}`)
        }
        set((s) => {
          const nextStates = { ...s.marketplacePluginStates }
          delete nextStates[plugin.id]
          return {
            marketplaceCatalog: s.marketplaceCatalog.filter((p) => p.id !== plugin.id),
            marketplacePluginStates: nextStates,
          }
        })
        prompt = `${plugin.name} is a skill i want to install, check clawhub and see if you can install this skill or tell me if theres any simmilar skill on claw hub. The listed slug ${plugin.installName} appears stale. Search clawhub, choose the closest valid skill, install it, and confirm with clawhub list.\n\nLive search output:\n${(search.output || search.error || 'Search failed or returned empty output').trim()}`
      }
    }

    set({
      marketplaceOpen: false,
      isExpanded: true,
    })

    setTimeout(() => {
      get().sendMessage(prompt)
    }, 120)
  },

  uninstallMarketplacePlugin: async (plugin) => {
    const result = await window.clui.uninstallPlugin(plugin.installName)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'not_installed' as PluginStatus },
        marketplaceInstalledNames: s.marketplaceInstalledNames.filter((n) => n !== plugin.installName),
      }))
    }
  },

  buildYourOwn: () => {
    set({ marketplaceOpen: false, isExpanded: true })
    // Small delay to let the UI transition
    setTimeout(() => {
      get().sendMessage('Help me create a new OpenClaw skill')
    }, 100)
  },

  closeTab: (tabId) => {
    window.clui.closeTab(tabId).catch(() => {})

    const s = get()
    const remaining = s.tabs.filter((t) => t.id !== tabId)

    if (s.activeTabId === tabId) {
      if (remaining.length === 0) {
        const newTab = makeLocalTab()
        set({ tabs: [newTab], activeTabId: newTab.id })
        return
      }
      const closedIndex = s.tabs.findIndex((t) => t.id === tabId)
      const newActive = remaining[Math.min(closedIndex, remaining.length - 1)]
      set({ tabs: remaining, activeTabId: newActive.id })
    } else {
      set({ tabs: remaining })
    }
  },

  clearTab: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, messages: [], lastResult: null, currentActivity: '', permissionQueue: [], permissionDenied: null, queuedPrompts: [] }
          : t
      ),
    }))
  },

  resumeSession: async (sessionId, title, projectPath) => {
    const defaultDir = projectPath || get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.clui.createTab()

      // Load previous conversation messages from the JSONL file.
      //
      // The bridge is a trust boundary: `.catch()` only covers a rejection, and
      // the sidecar used to *resolve* with an object here. `history.map` then
      // threw synchronously, the outer catch built a second tab with a fresh
      // id, and the control-plane tab created a line earlier was orphaned.
      const raw = await window.clui.loadSession(sessionId, defaultDir).catch(() => [])
      const history: SessionLoadMessage[] = Array.isArray(raw) ? raw : []
      const messages: Message[] = history.map((m) => ({
        id: nextMsgId(),
        role: m.role as Message['role'],
        content: m.content,
        toolName: m.toolName,
        toolStatus: m.toolName ? 'completed' as const : undefined,
        timestamp: m.timestamp,
      }))
      if (messages.length === 0) {
        messages.push({
          id: nextMsgId(),
          role: 'system',
          content: 'Resumed this session, but its earlier transcript could not be read. The conversation continues from here.',
          timestamp: Date.now(),
        })
      }

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        claudeSessionId: sessionId,
        sessionOrigin: 'local',
        title: title || 'Resumed Session',
        workingDirectory: defaultDir,
        hasChosenDirectory: !!projectPath,
        messages,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      // Don't call initSession — the first real prompt will use --resume with the sessionId
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.claudeSessionId = sessionId
      tab.title = title || 'Resumed Session'
      tab.workingDirectory = defaultDir
      tab.hasChosenDirectory = !!projectPath
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      return tab.id
    }
  },

  resumeGatewaySession: async (session, title) => {
    const defaultDir = get().staticInfo?.homePath || '~'
    const sessionKey = session.sessionKey
    try {
      const { tabId } = await window.clui.createTab()

      // The gateway is the only place this transcript exists — there is no
      // local file to fall back to, so a failure here means an empty tab and
      // the user is told so rather than left to infer it.
      const history = await window.clui
        .loadGatewaySession(sessionKey)
        .catch(() => null)
      const wire = history && Array.isArray(history.messages) ? history.messages : []
      const messages: Message[] = wire.map((m) => ({
        id: nextMsgId(),
        role: m.role as Message['role'],
        content: m.content,
        toolName: m.toolName,
        toolStatus: m.toolName ? ('completed' as const) : undefined,
        timestamp: m.timestamp,
      }))
      if (history?.truncated) {
        messages.unshift({
          id: nextMsgId(),
          role: 'system',
          content: `Showing the most recent ${messages.length} messages of this gateway session${
            history.totalMessages ? ` (${history.totalMessages} total)` : ''
          }.`,
          timestamp: wire[0]?.timestamp ?? Date.now(),
        })
      }
      if (messages.length === 0) {
        messages.push({
          id: nextMsgId(),
          role: 'system',
          content:
            history?.error ??
            'Reattached to this gateway session, but none of its history could be read. The conversation continues from here.',
          timestamp: Date.now(),
        })
      }

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        // The gateway session key, not a transcript UUID — it goes to
        // `--session-key`, which names a live session rather than replaying a
        // recorded one.
        claudeSessionId: sessionKey,
        sessionOrigin: 'gateway',
        title: title || 'Gateway Session',
        workingDirectory: defaultDir,
        hasChosenDirectory: false,
        messages,
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, isExpanded: true }))
      // Deliberately no initSession(): it submits a prompt with no sessionId,
      // the dispatcher then stamps `clui-<tabId>`, and the echoed session_init
      // would overwrite the key we just reattached to.
      return tabId
    } catch {
      // createTab failed, so there is no control-plane tab to attach to. Make a
      // local one rather than losing the click, exactly as resumeSession does.
      const tab = makeLocalTab()
      tab.claudeSessionId = sessionKey
      tab.sessionOrigin = 'gateway'
      tab.title = title || 'Gateway Session'
      tab.workingDirectory = defaultDir
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, isExpanded: true }))
      return tab.id
    }
  },

  addSystemMessage: (content) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() },
              ],
            }
          : t
      ),
    }))
  },

  // ─── Permission response ───

  respondPermission: (tabId, questionId, optionId) => {
    // Send to backend
    window.clui.respondPermission(tabId, questionId, optionId).catch(() => {})

    // Remove answered item from queue; show next tool's activity or clear
    set((s) => ({
      isExpanded: true,
      marketplaceOpen: false,
      controlCenterOpen: false,
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const remaining = t.permissionQueue.filter((p) => p.questionId !== questionId)
        return {
          ...t,
          permissionQueue: remaining,
          currentActivity: remaining.length > 0
            ? `Waiting for permission: ${remaining[0].toolTitle}`
            : 'Working...',
        }
      }),
    }))
  },

  // ─── Directory management ───

  addDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              additionalDirs: t.additionalDirs.includes(dir)
                ? t.additionalDirs
                : [...t.additionalDirs, dir],
            }
          : t
      ),
    }))
  },

  removeDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== dir) }
          : t
      ),
    }))
  },

  setBaseDirectory: (dir) => {
    const { activeTabId } = get()
    window.clui.resetTabSession(activeTabId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              workingDirectory: dir,
              hasChosenDirectory: true,
              claudeSessionId: null,
              additionalDirs: [],
            }
          : t
      ),
    }))
  },

  // ─── Attachment management ───

  addAttachments: (attachments) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: [...t.attachments, ...attachments] }
          : t
      ),
    }))
  },

  removeAttachment: (attachmentId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: t.attachments.filter((a) => a.id !== attachmentId) }
          : t
      ),
    }))
  },

  clearAttachments: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, attachments: [] } : t
      ),
    }))
  },

  // ─── Send ───

  sendMessage: (prompt, projectPath) => {
    const { activeTabId, tabs, staticInfo } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    // Use explicitly chosen directory, otherwise fall back to user home
    const resolvedPath = projectPath || (tab?.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab?.workingDirectory || '~'))
    if (!tab) return

    // Guard: single-turn mode — don't send new prompts while a run is active.
    if (tab.status === 'connecting' || tab.status === 'running') return
    const requestId = crypto.randomUUID()

    // Build full prompt with attachment context
    let fullPrompt = prompt
    if (tab.attachments.length > 0) {
      const attachmentCtx = tab.attachments
        .map((a) => `[Attached ${a.type}: ${a.path}]`)
        .join('\n')
      fullPrompt = `${attachmentCtx}\n\n${prompt}`
    }

    const title = tab.messages.length === 0
      ? (prompt.length > 30 ? prompt.substring(0, 27) + '...' : prompt)
      : tab.title

    // Optimistic update: clear attachments + append user message for active run.
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== activeTabId) return t
        const withEffectiveBase = t.hasChosenDirectory
          ? t
          : {
              ...t,
              // Once the user sends the first message, lock in the effective
              // base directory (home by default) so the footer no longer shows "—".
              hasChosenDirectory: true,
              workingDirectory: resolvedPath,
            }
        return {
          ...withEffectiveBase,
          status: 'connecting',
          activeRequestId: requestId,
          currentActivity: 'Starting...',
          title,
          attachments: [],
          messages: [
            ...withEffectiveBase.messages,
            { id: nextMsgId(), role: 'user' as const, content: prompt, timestamp: Date.now() },
          ],
        }
      }),
    }))

    // Send to backend — ControlPlane will queue if a run is active
    const { preferredModel, activeProvider } = get()
    const resolvedModel = preferredModel
      ? (preferredModel.includes('/') ? preferredModel : (activeProvider ? `${activeProvider}/${preferredModel}` : preferredModel))
      : undefined
    window.clui.prompt(activeTabId, requestId, {
      prompt: fullPrompt,
      projectPath: resolvedPath,
      sessionId: tab.claudeSessionId || undefined,
      model: resolvedModel,
      addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
      // Pin a gateway-resumed tab to the gateway. The control plane otherwise
      // stamps one process-global connection target onto every run, and under
      // a local target the same key names a *different*, empty conversation
      // that answers normally — the failure would be silent. This only ever
      // removes a wrong `--local`; it cannot choose which gateway answers.
      connection: tab.sessionOrigin === 'gateway' ? { mode: 'gateway' } : undefined,
    }).catch((err: Error) => {
      get().handleError(activeTabId, {
        message: err.message,
        stderrTail: [],
        exitCode: null,
        elapsedMs: 0,
        toolCallCount: 0,
      })
    })
  },

  // ─── Event handlers ───

  handleNormalizedEvent: (tabId, event) => {
    set((s) => {
      const { activeTabId } = s
      const tabs = s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const updated = { ...tab, lastEventAt: Date.now() }

        switch (event.type) {
          case 'session_init':
            // A gateway-resumed tab's key IS its address, and both openclaw
            // transports echo back whatever they were given — so this normally
            // assigns the same value. Guarded anyway: if anything ever reports
            // an id instead of the key, adopting it would silently redirect
            // every later turn at a different, empty session.
            if (tab.sessionOrigin !== 'gateway' || !tab.claudeSessionId) {
              updated.claudeSessionId = event.sessionId
            }
            updated.sessionModel = event.model
            updated.sessionTools = event.tools
            updated.sessionMcpServers = event.mcpServers
            updated.sessionSkills = event.skills
            updated.sessionVersion = event.version
            // Don't change status/activity for warmup inits — they're invisible
            if (!event.isWarmup) {
              updated.status = 'running'
              updated.currentActivity = 'Thinking...'
              // Move the first queued prompt into the timeline (it's now being processed)
              if (updated.queuedPrompts.length > 0) {
                const [nextPrompt, ...rest] = updated.queuedPrompts
                updated.queuedPrompts = rest
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                ]
              }
            }
            break

          case 'text_chunk': {
            updated.currentActivity = 'Writing...'
            const lastMsg = updated.messages[updated.messages.length - 1]
            if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
              updated.messages = [
                ...updated.messages.slice(0, -1),
                { ...lastMsg, content: lastMsg.content + event.text },
              ]
            } else {
              updated.messages = [
                ...updated.messages,
                { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
              ]
            }
            break
          }

          case 'tool_call':
            updated.currentActivity = `Running ${event.toolName}...`
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'tool',
                content: '',
                toolName: event.toolName,
                toolInput: '',
                toolStatus: 'running',
                timestamp: Date.now(),
              },
            ]
            break

          // Both of these used to mutate the message object in place and hand
          // back a new array. Zustand saw a change, but the tool rows are
          // React.memo'd on the message reference, so the streamed command and
          // the completed state never repainted — and the mutation also
          // rewrote the message inside the *previous* state snapshot.
          case 'tool_call_update': {
            const idx = lastRunningToolIndex(updated.messages)
            if (idx >= 0) {
              const target = updated.messages[idx]
              updated.messages = updated.messages.with(idx, {
                ...target,
                toolInput: (target.toolInput || '') + event.partialInput,
              })
            }
            break
          }

          case 'tool_call_complete': {
            const idx = lastRunningToolIndex(updated.messages)
            if (idx >= 0) {
              updated.messages = updated.messages.with(idx, {
                ...updated.messages[idx],
                toolStatus: 'completed',
              })
            }
            break
          }

          case 'task_update': {
            // ── Text fallback ──
            // text_chunk events (from stream_event deltas) are the primary render path.
            // If they didn't arrive for this run (timing, partial stream, etc.), the
            // assembled assistant event still has the full text — extract it here.
            // "This run" = everything after the last user message.
            if (event.message?.content) {
              const lastUserIdx = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasStreamedText = updated.messages
                .slice(lastUserIdx + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)

              if (!hasStreamedText) {
                const textContent = event.message.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text!)
                  .join('')
                if (textContent) {
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
                  ]
                }
              }

              // ── Tool card deduplication (unchanged) ──
              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  const exists = updated.messages.find(
                    (m) => m.role === 'tool' && m.toolName === block.name && !m.content
                  )
                  if (!exists) {
                    updated.messages = [
                      ...updated.messages,
                      {
                        id: nextMsgId(),
                        role: 'tool',
                        content: '',
                        toolName: block.name,
                        toolInput: JSON.stringify(block.input, null, 2),
                        toolStatus: 'completed',
                        timestamp: Date.now(),
                      },
                    ]
                  }
                }
              }
            }
            break
          }

          case 'task_complete':
            updated.status = 'completed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.lastResult = {
              totalCostUsd: event.costUsd,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              usage: event.usage,
              sessionId: event.sessionId,
            }
            // ── Final text fallback ──
            // If neither text_chunks nor task_update text produced an assistant message,
            // use event.result (the CLI's assembled final output) as last resort.
            if (event.result) {
              const lastUserIdx2 = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasAnyText = updated.messages
                .slice(lastUserIdx2 + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)
              if (!hasAnyText) {
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
                ]
              }
            }
            // Mark as unread unless the user is actively viewing this tab
            // (active tab with card expanded). A collapsed active tab still
            // counts as "unread" — the user hasn't seen the response yet.
            if (tabId !== activeTabId || !s.isExpanded) {
              updated.hasUnread = true
            }
            // Show fallback card when tools were denied by permission settings
            if (event.permissionDenials && event.permissionDenials.length > 0) {
              updated.permissionDenied = { tools: event.permissionDenials }
            } else {
              updated.permissionDenied = null
            }
            // Completion cues when app is hidden: sound + native desktop notification
            void playNotificationIfHidden()
            void showCompletionNotificationIfHidden(
              'OpenClaw UI: Prompt finished',
              latestAssistantPreview(updated.messages),
            )
            break

          case 'error':
            updated.status = 'failed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
            ]
            break

          case 'session_dead':
            updated.status = 'dead'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'system',
                content: `Session ended unexpectedly (exit ${event.exitCode})`,
                timestamp: Date.now(),
              },
            ]
            break

          case 'permission_request': {
            const newReq: import('../../shared/types').PermissionRequest = {
              questionId: event.questionId,
              toolTitle: event.toolName,
              toolDescription: event.toolDescription,
              toolInput: event.toolInput,
              options: event.options.map((o) => ({
                optionId: o.id,
                kind: o.kind,
                label: o.label,
              })),
            }
            updated.permissionQueue = [...updated.permissionQueue, newReq]
            updated.currentActivity = `Waiting for permission: ${event.toolName}`
            break
          }

          case 'gateway_state':
            updated.gatewayState = event.state
            // Only a disconnect is worth interrupting the timeline for;
            // connect/reconnect churn would be noise.
            if (event.state === 'disconnected') {
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Gateway disconnected${event.detail ? ` — ${event.detail}` : ''}`,
                  timestamp: Date.now(),
                },
              ]
            }
            break

          case 'rate_limit':
            if (event.status !== 'allowed') {
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                  timestamp: Date.now(),
                },
              ]
            }
            break
        }

        return updated
      })

      return { tabs }
    })
  },

  handleStatusChange: (tabId, newStatus) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: newStatus as TabStatus,
              lastEventAt: Date.now(),
              // Clear activity when transitioning to idle (e.g., after warmup init)
              ...(newStatus === 'idle' ? { currentActivity: '', permissionQueue: [] as import('../../shared/types').PermissionRequest[], permissionDenied: null } : {}),
            }
          : t
      ),
    }))
  },

  handleError: (tabId, error) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t

        // Deduplicate: skip if the last message is already an error for this failure
        const lastMsg = t.messages[t.messages.length - 1]
        const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

        return {
          ...t,
          status: 'failed',
          activeRequestId: null,
          currentActivity: '',
          permissionQueue: [],
          messages: alreadyHasError
            ? t.messages
            : [
                ...t.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
                  timestamp: Date.now(),
                },
              ],
        }
      }),
    }))
  },
}))
