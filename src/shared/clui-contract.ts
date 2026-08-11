import { IPC } from './types'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, Attachment, SessionMeta, CatalogPlugin, SessionLoadMessage, ConnectionTarget, GatewayConfigView, NodeAction, NodeHostStatus } from './types'
import type { ShortcutDef } from './shortcuts'
import type { Theme } from './theme-types'

/**
 * The `window.clui` contract.
 *
 * This file is never executed. It was the Electron preload; now that the shell
 * is a saucer/C++ window with a Node sidecar behind it, `window.clui` is
 * generated instead — `sidecar/gen-shim.mjs` reads this file as text and emits
 * `shell/web/clui-shim.js` from it. Keeping one declarative source means the
 * shim cannot drift from what the renderer actually calls: add a method here
 * and it appears in the shim, or the generator fails loudly on an unknown
 * channel.
 *
 * The three helpers below exist only to mark each method's transport in a form
 * both a human and the generator can read. They have no runtime behaviour, and
 * nothing imports the `api` value — only the {@link CluiAPI} type is consumed,
 * by the renderer's global Window declaration.
 */
type Unsubscribe = () => void

/** Request-response: the sidecar replies and the promise settles. */
declare function invoke(channel: string, payload?: unknown): Promise<any>
/** Fire-and-forget: no reply, no promise. */
declare function send(channel: string, ...payload: unknown[]): void
/** Push channel: the sidecar (or shell) emits, the renderer listens. */
declare function subscribe(channel: string, callback: (...args: any[]) => void): Unsubscribe

export interface StartInfo {
  version: string
  auth: { email?: string; subscriptionType?: string; authMethod?: string }
  mcpServers: string[]
  projectPath: string
  homePath: string
  cliBinary: string
  cliCommand: string
  authSupported: boolean
  mcpSupported: boolean
}

export interface CluiAPI {
  // ─── Request-response (renderer → main) ───
  /**
   * Static CLI info. Answers from cache, so the fields the CLI has to be
   * spawned for (version, auth, MCP list) may be placeholders on a first-ever
   * launch — {@link CluiAPI.onStartInfo} delivers the real values when the
   * probes behind them finish.
   */
  start(): Promise<StartInfo>
  createTab(): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  tabHealth(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openExternal(url: string): Promise<boolean>
  openInTerminal(sessionId: string | null, projectPath?: string): Promise<boolean>
  attachFiles(): Promise<Attachment[] | null>
  takeScreenshot(): Promise<Attachment | null>
  pasteImage(dataUrl: string): Promise<Attachment | null>
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>
  exportConversation(args: { format: 'md' | 'json'; suggestedName: string; content: string }): Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }>
  getDiagnostics(): Promise<any>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  initSession(tabId: string): void
  resetTabSession(tabId: string): void
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  loadSession(sessionId: string, projectPath?: string): Promise<SessionLoadMessage[]>
  fetchMarketplace(forceRefresh?: boolean): Promise<{ plugins: CatalogPlugin[]; error: string | null }>
  listInstalledPlugins(): Promise<string[]>
  installPlugin(repo: string, pluginName: string, marketplace: string, sourcePath?: string, isSkillMd?: boolean): Promise<{ ok: boolean; error?: string }>
  uninstallPlugin(pluginName: string): Promise<{ ok: boolean; error?: string }>
  openclawHealth(): Promise<{ ok: boolean; output: string; error: string | null }>
  openclawOnboard(): Promise<{ ok: boolean; error?: string }>
  openPath(path: string): Promise<boolean>
  openclawModelInfo(): Promise<{
    ok: boolean
    provider: string | null
    model: string | null
    providers: Array<{ id: string; models: Array<{ id: string; name: string }> }>
    error?: string
  }>
  openclawSetModel(provider: string, model: string): Promise<{ ok: boolean; error?: string }>
  openclawRun(action: string): Promise<{ ok: boolean; output: string; error?: string }>
  getRuntimeMetrics(): Promise<{ cpuPercent: number; memoryMb: number; uptimeSec: number; timestamp: number }>

  // ─── Node host + gateway ───
  nodeStatus(): Promise<NodeHostStatus>
  nodeAction(action: NodeAction): Promise<{ ok: boolean; output: string; error?: string }>
  gatewayStatus(): Promise<{ ok: boolean; running: boolean; installed: boolean; output: string }>
  gatewayProbe(): Promise<{
    ok: boolean
    reachable: boolean
    capability: string | null
    missingOperatorScope: boolean
    output: string
  }>
  gatewayConfigGet(): Promise<GatewayConfigView>
  gatewayConfigSet(patch: { mode?: 'local' | 'remote'; remoteUrl?: string; tokenEnvVar?: string }): Promise<{ ok: boolean; error?: string }>
  getConnectionTarget(): Promise<ConnectionTarget>
  setConnectionTarget(target: ConnectionTarget): Promise<{ ok: boolean; error?: string }>
  getShortcuts(): Promise<{ platform: string; shortcuts: ShortcutDef[] }>

  // ─── Theming + branding ───
  exportTheme(theme: Theme, suggestedName: string): Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }>
  importTheme(): Promise<{ ok: boolean; cancelled?: boolean; theme?: Theme; error?: string }>
  setBranding(branding: { appName: string; tagline: string }): void
  /** Diagnostic only — forwards shell geometry samples to the debug log. */
  traceShell(line: string): void
  setPermissionMode(mode: string): void
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void

  // ─── Window management ───
  resizeHeight(height: number): void
  setWindowWidth(width: number): void
  animateHeight(from: number, to: number, durationMs: number): Promise<void>
  hideWindow(): void
  isVisible(): Promise<boolean>
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void

  // ─── Event listeners (main → renderer) ───
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: { name: string; state: string; error?: string; reason?: string }) => void): () => void
  /** Fires when a background refresh produces fresher static CLI info. */
  onStartInfo(callback: (info: StartInfo) => void): () => void
  /** Fires when a background refresh produces a fresher node host status. */
  onNodeStatusUpdate(callback: (status: NodeHostStatus) => void): () => void
  onWindowShown(callback: () => void): () => void
  /** main -> renderer: settle the DOM; the window is about to be revealed. */
  onWindowPrepare(callback: (generation: number) => void): () => void
  onWindowDismiss(callback: (generation: number) => void): () => void
  dismissReady(generation: number): void
  /** renderer -> main: prepare pass painted, safe to reveal. */
  windowReady(generation: number): void
  onShortcutAction(callback: (action: string) => void): () => void
  setDragHolding(holding: boolean): void
}

const api: CluiAPI = {
  // ─── Request-response ───
  start: () => invoke(IPC.START),
  createTab: () => invoke(IPC.CREATE_TAB),
  prompt: (tabId, requestId, options) => invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => invoke(IPC.CANCEL, requestId),
  stopTab: (tabId) => invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => invoke(IPC.STATUS),
  tabHealth: () => invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => invoke(IPC.CLOSE_TAB, tabId),
  selectDirectory: () => invoke(IPC.SELECT_DIRECTORY),
  openExternal: (url) => invoke(IPC.OPEN_EXTERNAL, url),
  openInTerminal: (sessionId, projectPath) => invoke(IPC.OPEN_IN_TERMINAL, { sessionId, projectPath }),
  attachFiles: () => invoke(IPC.ATTACH_FILES),
  takeScreenshot: () => invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) => invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  exportConversation: (args) => invoke(IPC.EXPORT_CONVERSATION, args),
  getDiagnostics: () => invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  initSession: (tabId) => send(IPC.INIT_SESSION, tabId),
  resetTabSession: (tabId) => send(IPC.RESET_TAB_SESSION, tabId),
  listSessions: (projectPath?: string) => invoke(IPC.LIST_SESSIONS, projectPath),
  loadSession: (sessionId: string, projectPath?: string) => invoke(IPC.LOAD_SESSION, { sessionId, projectPath }),
  fetchMarketplace: (forceRefresh) => invoke(IPC.MARKETPLACE_FETCH, { forceRefresh }),
  listInstalledPlugins: () => invoke(IPC.MARKETPLACE_INSTALLED),
  installPlugin: (repo, pluginName, marketplace, sourcePath, isSkillMd) =>
    invoke(IPC.MARKETPLACE_INSTALL, { repo, pluginName, marketplace, sourcePath, isSkillMd }),
  uninstallPlugin: (pluginName) =>
    invoke(IPC.MARKETPLACE_UNINSTALL, { pluginName }),
  openclawHealth: () => invoke(IPC.OPENCLAW_HEALTH),
  openclawOnboard: () => invoke(IPC.OPENCLAW_ONBOARD),
  openPath: (path) => invoke(IPC.OPEN_PATH, path),
  openclawModelInfo: () => invoke(IPC.OPENCLAW_MODEL_INFO),
  openclawSetModel: (provider, model) => invoke(IPC.OPENCLAW_SET_MODEL, { provider, model }),
  openclawRun: (action) => invoke(IPC.OPENCLAW_RUN, { action }),
  getRuntimeMetrics: () => invoke(IPC.GET_RUNTIME_METRICS),

  // ─── Node host + gateway ───
  nodeStatus: () => invoke(IPC.NODE_STATUS),
  nodeAction: (action) => invoke(IPC.NODE_ACTION, { action }),
  gatewayStatus: () => invoke(IPC.GATEWAY_STATUS),
  gatewayProbe: () => invoke(IPC.GATEWAY_PROBE),
  gatewayConfigGet: () => invoke(IPC.GATEWAY_CONFIG_GET),
  gatewayConfigSet: (patch) => invoke(IPC.GATEWAY_CONFIG_SET, patch),
  getConnectionTarget: () => invoke(IPC.GET_CONNECTION_TARGET),
  setConnectionTarget: (target) => invoke(IPC.SET_CONNECTION_TARGET, target),
  getShortcuts: () => invoke(IPC.GET_SHORTCUTS),

  // ─── Theming + branding ───
  exportTheme: (theme, suggestedName) => invoke(IPC.THEME_EXPORT, { theme, suggestedName }),
  importTheme: () => invoke(IPC.THEME_IMPORT),
  setBranding: (branding) => send(IPC.SET_BRANDING, branding),
  traceShell: (line) => send(IPC.TRACE_SHELL, line),
  setPermissionMode: (mode) => send(IPC.SET_PERMISSION_MODE, mode),
  getTheme: () => invoke(IPC.GET_THEME),
  onThemeChange: (callback) => subscribe(IPC.THEME_CHANGED, callback),

  // ─── Window management ───
  resizeHeight: (height) => send(IPC.RESIZE_HEIGHT, height),
  animateHeight: (from, to, durationMs) =>
    invoke(IPC.ANIMATE_HEIGHT, { from, to, durationMs }),
  hideWindow: () => send(IPC.HIDE_WINDOW),
  isVisible: () => invoke(IPC.IS_VISIBLE),
  setIgnoreMouseEvents: (ignore, options) =>
    send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  setWindowWidth: (width) => send(IPC.SET_WINDOW_WIDTH, width),

  // ─── Event listeners ───
  // Every normalized run event arrives on one channel, tagged with its tab.
  onEvent: (callback) => subscribe('clui:normalized-event', callback),
  onTabStatusChange: (callback) => subscribe('clui:tab-status-change', callback),
  onError: (callback) => subscribe('clui:enriched-error', callback),
  onSkillStatus: (callback) => subscribe(IPC.SKILL_STATUS, callback),
  onStartInfo: (callback) => subscribe(IPC.START_INFO, callback),
  onNodeStatusUpdate: (callback) => subscribe(IPC.NODE_STATUS_UPDATE, callback),
  onWindowShown: (callback) => subscribe(IPC.WINDOW_SHOWN, callback),
  onWindowPrepare: (callback) => subscribe(IPC.WINDOW_PREPARE, callback),
  onWindowDismiss: (callback) => subscribe(IPC.WINDOW_DISMISS, callback),
  onShortcutAction: (callback) => subscribe('clui:shortcut-action', callback),

  // The shell owns the window lifecycle, so the generator overrides these two
  // to call into saucer directly rather than forwarding them to the sidecar.
  windowReady: (generation) => send(IPC.WINDOW_READY, generation),
  dismissReady: (generation) => send(IPC.WINDOW_DISMISS_READY, generation),

  setDragHolding: (holding) => send(IPC.DRAG_HOLDING, holding),
}

// Exported so the contract is a value the compiler checks against CluiAPI,
// rather than an unreferenced literal it can quietly let rot.
export { api as cluiContract }
