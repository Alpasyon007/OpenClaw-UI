import React, { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Robot, SlidersHorizontal, Terminal, Play, Stop, ArrowsClockwise, FolderOpen, Keyboard, ClipboardText, Heartbeat, Sparkle, Palette } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useShortcuts } from '../hooks/useShortcuts'
import { formatShortcut } from '../../shared/shortcuts'
import { ScrollableSelect } from './ScrollableSelect'
import { AppearancePanel } from './AppearancePanel'

function formatStatusText(text: string | null | undefined, maxLines = 5): string {
  if (!text) return ''
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[\s\-_=+|:┄─━┈]{8,}$/.test(line))
    .slice(0, maxLines)
    .join('\n')
}

type CommandEntry = { id: string; label: string; aliases: string[] }

const COMMANDS: CommandEntry[] = [
  { id: 'gateway_start', label: 'gateway start', aliases: ['start gateway', 'gateway up'] },
  { id: 'gateway_stop', label: 'gateway stop', aliases: ['stop gateway', 'gateway down'] },
  { id: 'channels_status', label: 'channels status', aliases: ['channel status', 'status channels'] },
  { id: 'plugins_list', label: 'plugins list', aliases: ['list plugins'] },
  { id: 'skills_list', label: 'skills list', aliases: ['list skills'] },
  { id: 'update_check', label: 'update check', aliases: ['check update'] },
  { id: 'update_upgrade', label: 'update upgrade', aliases: ['upgrade update', 'install update'] },
]

function nearestCommand(query: string): CommandEntry | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const scored = COMMANDS.map((cmd) => {
    const fields = [cmd.label, ...cmd.aliases]
    const starts = fields.some((f) => f.startsWith(needle))
    const includes = fields.some((f) => f.includes(needle))
    const score = starts ? 3 : includes ? 2 : 0
    return { cmd, score }
  }).filter((s) => s.score > 0)
  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  return scored[0].cmd
}

export function ControlCenterPanel() {
  const colors = useColors()
  const tab = useSessionStore((s) => s.controlCenterTab)
  const setTab = useSessionStore((s) => s.setControlCenterTab)
  const close = useSessionStore((s) => s.closeControlCenter)

  return (
    // Fills whatever height the parent allows rather than demanding 560px —
    // a fixed height here is what pushed the panel off the top of the window
    // when a conversation was open below it.
    <div data-clui-ui style={{ flex: 1, minHeight: 0, maxHeight: 560, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${colors.containerBorder}` }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TabBtn active={tab === 'agents'} label="Agents" icon={<Robot size={14} />} onClick={() => setTab('agents')} colors={colors} />
          <TabBtn active={tab === 'settings'} label="Settings" icon={<SlidersHorizontal size={14} />} onClick={() => setTab('settings')} colors={colors} />
          <TabBtn active={tab === 'appearance'} label="Appearance" icon={<Palette size={14} />} onClick={() => setTab('appearance')} colors={colors} />
        </div>
        <button onClick={close} style={{ background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer' }}>
          <X size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${tab}-tab`}
            initial={{ opacity: 0, y: 10, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.995 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'agents' && <AgentsTab />}
            {tab === 'settings' && <SettingsTab />}
            {tab === 'appearance' && <AppearancePanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function AgentsTab() {
  const colors = useColors()
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const [output, setOutput] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [cpuPercent, setCpuPercent] = useState(0)
  const [memoryMb, setMemoryMb] = useState(0)
  const [activeTasks, setActiveTasks] = useState(0)
  const [failedTasks, setFailedTasks] = useState(0)
  const [cmdInput, setCmdInput] = useState('')
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('openclaw-command-history')
      if (!raw) return []
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((v) => typeof v === 'string') : []
    } catch {
      return []
    }
  })

  const appendLog = (line: string) => {
    const stamp = new Date().toLocaleTimeString()
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 120))
  }

  const suggestions = (() => {
    const q = cmdInput.trim().toLowerCase()
    if (!q) return []
    return COMMANDS
      .filter((cmd) => [cmd.label, ...cmd.aliases].some((f) => f.includes(q)))
      .slice(0, 6)
  })()

  const run = async (action: string) => {
    setBusy(true)
    const res = await window.clui.openclawRun(action)
    if (res.ok) {
      setOutput(res.output || 'Done')
      appendLog(`${action} succeeded`)
    } else {
      setOutput(`${res.error || 'Failed'}\n${res.output || ''}`.trim())
      appendLog(`${action} failed`)
    }
    setBusy(false)
  }

  const runByInput = async () => {
    const typed = cmdInput.trim()
    if (!typed) return
    const direct = COMMANDS.find((c) => c.label === typed.toLowerCase())
    const suggested = direct || nearestCommand(typed)
    if (!suggested) {
      appendLog(`Unknown command: "${typed}"`)
      return
    }
    if (!direct && suggested) {
      appendLog(`Auto-corrected "${typed}" -> "${suggested.label}"`)
    }
    const nextHistory = [suggested.label, ...history.filter((h) => h !== suggested.label)].slice(0, 12)
    setHistory(nextHistory)
    localStorage.setItem('openclaw-command-history', JSON.stringify(nextHistory))
    setCmdInput('')
    await run(suggested.id)
  }

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      // The launcher spends most of its life parked off screen with background
      // throttling disabled, so an unconditional 1Hz poll keeps main, IPC and
      // React busy for a card nobody can see.
      if (document.hidden) return
      try {
        const [metrics, health] = await Promise.all([
          window.clui.getRuntimeMetrics(),
          window.clui.tabHealth(),
        ])
        if (cancelled) return
        setCpuPercent(metrics.cpuPercent || 0)
        setMemoryMb(metrics.memoryMb || 0)
        const tasks = Array.isArray(health?.tabs)
          ? health.tabs.filter((t: any) => t.alive || t.status === 'running' || t.status === 'connecting')
          : []
        const failed = Array.isArray(health?.tabs)
          ? health.tabs.filter((t: any) => t.status === 'failed' || t.status === 'dead').length
          : 0
        setActiveTasks(tasks.length)
        setFailedTasks(failed)
      } catch {
        if (!cancelled) appendLog('Live monitor poll failed')
      }
    }
    const timer = setInterval(() => { void poll() }, 1000)
    void poll()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Card title="Live Monitor" colors={colors}>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: colors.textSecondary }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: failedTasks > 0 ? '#ef4444' : activeTasks > 0 ? '#f59e0b' : '#22c55e', boxShadow: `0 0 10px ${failedTasks > 0 ? 'rgba(239,68,68,0.4)' : activeTasks > 0 ? 'rgba(245,158,11,0.4)' : 'rgba(34,197,94,0.35)'}` }} />
            {failedTasks > 0 ? 'Degraded' : activeTasks > 0 ? 'Busy' : 'Healthy'}
          </div>
          <div style={{ fontSize: 11, color: colors.textSecondary }}>CPU: {cpuPercent}%</div>
          <div style={{ fontSize: 11, color: colors.textSecondary }}>RAM: {memoryMb} MB</div>
          <div style={{ fontSize: 11, color: colors.textSecondary }}>Active tasks: {activeTasks}</div>
        </div>
      </Card>
      <ConnectionCard colors={colors} onLog={appendLog} />
      <NodeHostCard colors={colors} onLog={appendLog} />
      <Card title="Local Gateway" colors={colors}>
        <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 7, lineHeight: 1.45 }}>
          Runs a gateway on this machine (loopback). Not used while the connection above targets a remote gateway.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Action onClick={() => { void run('gateway_start') }} label="Start" icon={<Play size={11} />} colors={colors} />
          <Action onClick={() => { void run('gateway_stop') }} label="Stop" icon={<Stop size={11} />} colors={colors} />
        </div>
      </Card>
      <Card title="Channels" colors={colors}>
        <Action onClick={() => { void run('channels_status') }} label="Channel Status" icon={<ArrowsClockwise size={11} />} colors={colors} />
        <Action onClick={() => { void window.clui.openInTerminal(null, staticInfo?.homePath || '~') }} label="Open Terminal" icon={<Terminal size={11} />} colors={colors} />
      </Card>
      <Card title="Plugins & Skills" colors={colors}>
        <Action onClick={() => { void run('plugins_list') }} label="List Plugins" icon={<ArrowsClockwise size={11} />} colors={colors} />
        <Action onClick={() => { void run('skills_list') }} label="List Skills" icon={<ArrowsClockwise size={11} />} colors={colors} />
      </Card>
      <Card title="Paths" colors={colors}>
        <Action onClick={() => { if (staticInfo?.homePath) void window.clui.openPath(`${staticInfo.homePath}/.openclaw`) }} label="Open ~/.openclaw" icon={<FolderOpen size={11} />} colors={colors} />
        <Action onClick={() => { if (staticInfo?.homePath) void window.clui.openPath(`${staticInfo.homePath}/.openclaw/workspace`) }} label="Open Workspace" icon={<FolderOpen size={11} />} colors={colors} />
      </Card>

      <div style={{ gridColumn: '1 / -1' }}>
        <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 10, background: colors.surfacePrimary, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 6 }}>
            Smart Command
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runByInput() } }}
              placeholder='Try: "gateway start", "plugins list", "update check"...'
              style={{
                flex: 1,
                fontSize: 11,
                borderRadius: 8,
                background: colors.surfaceHover,
                color: colors.textPrimary,
                border: `1px solid ${colors.containerBorder}`,
                padding: '7px 9px',
              }}
            />
            <Action onClick={() => { void runByInput() }} label="Run" icon={<Play size={11} />} colors={colors} />
          </div>
          {suggestions.length > 0 && (
            <div style={{ marginTop: 7, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setCmdInput(s.label) }}
                  style={{
                    fontSize: 10,
                    borderRadius: 999,
                    border: `1px solid ${colors.containerBorder}`,
                    background: colors.surfaceHover,
                    color: colors.textSecondary,
                    padding: '3px 8px',
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {history.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 10, color: colors.textTertiary, overflowWrap: 'anywhere' }}>
              Recent: {history.slice(0, 4).join(' • ')}
            </div>
          )}
        </div>

        <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 10, background: colors.surfacePrimary, padding: 10, minHeight: 140 }}>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 6 }}>
            Command Output {busy ? '(running...)' : ''}
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, color: colors.textTertiary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {output || 'Run an action to see output.'}
          </pre>
        </div>
        <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 10, background: colors.surfacePrimary, padding: 10, minHeight: 120, marginTop: 10 }}>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 6 }}>
            Live Logs (auto-refresh)
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 10, color: colors.textTertiary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', maxHeight: 160, overflowY: 'auto' }}>
            {logs.length > 0 ? logs.join('\n') : 'Waiting for live events...'}
          </pre>
        </div>
      </div>
    </div>
  )
}

function SettingsTab() {
  const colors = useColors()
  const { platform, shortcuts } = useShortcuts()
  const openclawModels = useSessionStore((s) => s.openclawModels)
  const activeProvider = useSessionStore((s) => s.activeProvider)
  const currentModel = useSessionStore((s) => s.currentOpenclawModel)
  const refresh = useSessionStore((s) => s.refreshOpenclawModels)
  const setOpenclawModel = useSessionStore((s) => s.setOpenclawModel)
  const openclawUpdateInfo = useSessionStore((s) => s.openclawUpdateInfo)
  const openclawUpdateBusy = useSessionStore((s) => s.openclawUpdateBusy)
  const checkOpenclawUpdate = useSessionStore((s) => s.checkOpenclawUpdate)
  const runOpenclawUpgrade = useSessionStore((s) => s.runOpenclawUpgrade)
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const toggleMarketplace = useSessionStore((s) => s.toggleMarketplace)
  const closeControlCenter = useSessionStore((s) => s.closeControlCenter)
  const modelsLoading = useSessionStore((s) => s.openclawModelsLoading)
  const modelError = useSessionStore((s) => s.openclawModelError)
  const [healthChecking, setHealthChecking] = useState(false)
  const [healthText, setHealthText] = useState<string | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [utilityText, setUtilityText] = useState<string | null>(null)
  const [providers, setProviders] = useState<string[]>([])
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [pendingProvider, setPendingProvider] = useState<string>('')
  const [pendingModel, setPendingModel] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // One fetch, not two. Against a remote gateway each round trip is ~9s,
      // so the previous refresh()-then-fetch pair left the dropdowns empty
      // long enough to look like the picker was broken.
      const info = await window.clui.openclawModelInfo()
      if (cancelled || !info.ok) return
      const ids = info.providers.map((p) => p.id)
      const map: Record<string, Array<{ id: string; name: string }>> = {}
      for (const p of info.providers) map[p.id] = p.models
      setProviders(ids)
      setProviderModels(map)
      setPendingProvider(info.provider || ids[0] || '')
      // Populate the shared store from the same payload (main-side caching
      // makes this second call effectively free).
      void refresh()
    })()
    return () => { cancelled = true }
  }, [refresh])

  useEffect(() => {
    if (currentModel) setPendingModel(currentModel)
  }, [currentModel])

  useEffect(() => {
    if (activeProvider) setPendingProvider(activeProvider)
  }, [activeProvider])

  useEffect(() => {
    const models = providerModels[pendingProvider] || []
    if (models.length === 0) return
    const hasCurrent = models.some((m) => m.id === pendingModel)
    if (!hasCurrent) setPendingModel(models[0].id)
  }, [pendingProvider, providerModels, pendingModel])

  const visibleModels = providerModels[pendingProvider] || openclawModels.map((m) => ({ id: m.id, name: m.label }))
  const cleanUpdateInfo = formatStatusText(openclawUpdateInfo, 6)

  const runHealth = async () => {
    setHealthChecking(true)
    const res = await window.clui.openclawHealth()
    if (res.ok) {
      const singleLine = formatStatusText(res.output, 1) || 'OK'
      setHealthText(`Health: ${singleLine}`)
    } else {
      setHealthText(`Health failed: ${res.error || 'Unknown error'}`)
    }
    setHealthChecking(false)
  }

  const openOnboarding = () => {
    localStorage.setItem('openclaw-onboarding-dismissed', '0')
    window.dispatchEvent(new Event('openclaw:show-onboarding'))
  }

  const copyDiagnostics = async () => {
    try {
      const payload = await window.clui.getDiagnostics()
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setUtilityText('Diagnostics copied to clipboard.')
    } catch {
      setUtilityText('Failed to copy diagnostics.')
    }
  }

  const shortcutLines = [
    ...shortcuts.map((s) => `${formatShortcut(s, platform)} — ${s.action}`),
    'Esc — Hide window',
  ]

  const copyShortcutCheatsheet = async () => {
    try {
      await navigator.clipboard.writeText(shortcutLines.join('\n'))
      setUtilityText('Shortcut list copied.')
    } catch {
      setUtilityText('Failed to copy shortcut list.')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Model Controls" colors={colors}>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 8 }}>
          OpenClaw currently enforces one active provider at a time.
        </div>
        {modelsLoading && (
          <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 8 }}>
            Talking to the gateway — this takes a few seconds...
          </div>
        )}
        {modelError && (
          <div style={{ fontSize: 10, color: '#ef4444', marginBottom: 8, lineHeight: 1.45 }}>
            {modelError}
          </div>
        )}
        {!modelsLoading && !modelError && providers.length === 0 && (
          <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 8, lineHeight: 1.45 }}>
            No models reported. If you are on a remote gateway, its credentials may not cover any model.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <ScrollableSelect
            ariaLabel="Provider"
            value={pendingProvider}
            onChange={setPendingProvider}
            disabled={modelsLoading}
            placeholder="Provider..."
            options={(providers.length > 0 ? providers : [activeProvider || ''])
              .filter(Boolean)
              .map((providerId) => ({ value: providerId, label: providerId }))}
          />
          <div style={{ fontSize: 11, color: colors.textSecondary, display: 'flex', alignItems: 'center', paddingLeft: 6 }}>
            Active provider: <strong style={{ marginLeft: 4 }}>{activeProvider || 'unknown'}</strong>
          </div>
        </div>
        <ScrollableSelect
          ariaLabel="Model"
          value={pendingModel}
          onChange={setPendingModel}
          disabled={modelsLoading}
          placeholder={visibleModels.length === 0 ? 'No models available' : 'Model...'}
          options={visibleModels.map((m) => ({
            value: m.id,
            label: m.name && m.name !== m.id ? `${m.name}` : m.id,
            hint: m.name && m.name !== m.id ? m.id : undefined,
          }))}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 7, alignItems: 'center' }}>
          <Action
            onClick={() => { if (pendingProvider && pendingModel) void setOpenclawModel(pendingProvider, pendingModel) }}
            label={modelsLoading ? 'Applying...' : 'Apply Model'}
            icon={<Play size={11} />}
            colors={colors}
            disabled={modelsLoading || !pendingProvider || !pendingModel}
          />
          <Action
            onClick={() => { void refresh() }}
            label="Refresh"
            icon={<ArrowsClockwise size={11} />}
            colors={colors}
            disabled={modelsLoading}
          />
          {currentModel && (
            <span style={{ fontSize: 10, color: colors.textTertiary, overflowWrap: 'anywhere' }}>
              Active: {activeProvider}/{currentModel}
            </span>
          )}
        </div>
      </Card>

      <Card title="Theme Mode" colors={colors}>
        <div style={{ fontSize: 11, color: colors.textSecondary }}>
          Light theme is supported. Use quick settings in the top-right dots menu to toggle between dark and light.
        </div>
      </Card>

      <Card title="OpenClaw Info" colors={colors}>
        <div style={{ fontSize: 11, color: colors.textSecondary }}>CLI: {staticInfo?.cliCommand || 'openclaw'} {staticInfo?.version || 'unknown'}</div>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginTop: 4 }}>Auth: {staticInfo?.email || (staticInfo?.authSupported === false ? 'not exposed' : 'not connected')}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 7 }}>
          <Action onClick={() => { void runHealth() }} label={healthChecking ? 'Checking Health...' : 'Health'} icon={<Heartbeat size={11} />} colors={colors} />
          <Action onClick={() => { void checkOpenclawUpdate() }} label={openclawUpdateBusy ? 'Checking...' : 'Check Update'} icon={<ArrowsClockwise size={11} />} colors={colors} />
          <Action onClick={() => { void runOpenclawUpgrade() }} label={openclawUpdateBusy ? 'Upgrading...' : 'Upgrade'} icon={<Play size={11} />} colors={colors} />
        </div>
        {healthText && (
          <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {healthText}
          </div>
        )}
        {cleanUpdateInfo && (
          <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {cleanUpdateInfo}
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <Action
            onClick={() => {
              closeControlCenter()
              toggleMarketplace()
            }}
            label="Open Skills Marketplace"
            icon={<ArrowsClockwise size={11} />}
            colors={colors}
          />
        </div>
      </Card>

      <Card title="Utilities" colors={colors}>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <Action onClick={() => { void copyDiagnostics() }} label="Copy Diagnostics" icon={<ClipboardText size={11} />} colors={colors} />
          <Action onClick={() => { void copyShortcutCheatsheet() }} label="Copy Keys" icon={<Keyboard size={11} />} colors={colors} />
          <Action onClick={openOnboarding} label="Reopen Onboarding" icon={<Sparkle size={11} />} colors={colors} />
          <Action onClick={() => setShowShortcuts((v) => !v)} label={showShortcuts ? 'Hide Keys' : 'Show Keys'} icon={<Keyboard size={11} />} colors={colors} />
        </div>
        {showShortcuts && (
          <div style={{ marginTop: 8, fontSize: 10, color: colors.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
            {shortcutLines.join('\n')}
          </div>
        )}
        {utilityText && (
          <div style={{ marginTop: 8, fontSize: 10, color: colors.textTertiary }}>
            {utilityText}
          </div>
        )}
      </Card>

      <Card title="Credits & Attribution" colors={colors}>
        <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
          Original project foundation by lcoutodemos (clui-cc). This OpenClaw UI fork is maintained by Muhammad Daud Nasir.
        </div>
        <div style={{ marginTop: 8 }}>
          <Action onClick={() => { void window.clui.openExternal('https://github.com/lcoutodemos/clui-cc') }} label="Open Original Repo" icon={<FolderOpen size={11} />} colors={colors} />
        </div>
      </Card>
    </div>
  )
}

type Colors = ReturnType<typeof useColors>

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const color = tone === 'ok' ? '#22c55e' : tone === 'warn' ? '#f59e0b' : tone === 'bad' ? '#ef4444' : '#6b7280'
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        background: color,
        flexShrink: 0,
        boxShadow: `0 0 10px ${color}66`,
      }}
    />
  )
}

function Field({ label, value, colors }: { label: string; value: string; colors: Colors }) {
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 10, lineHeight: 1.5 }}>
      <span style={{ color: colors.textTertiary, flexShrink: 0 }}>{label}</span>
      <span style={{ color: colors.textSecondary, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

/**
 * Which agent runtime prompts are routed to, plus a live reachability probe.
 *
 * `auto` defers to the CLI's own `gateway.mode`. Selecting Remote both writes
 * `gateway.mode: "remote"` (the key the CLI actually reads) and sets an
 * explicit per-run target, so routing does not depend on config alone.
 */
function ConnectionCard({ colors, onLog }: { colors: Colors; onLog: (line: string) => void }) {
  const [config, setConfig] = useState<import('../../shared/types').GatewayConfigView | null>(null)
  const [mode, setMode] = useState<import('../../shared/types').ConnectionMode>('auto')
  const [probe, setProbe] = useState<{ reachable: boolean; capability: string | null; missingOperatorScope: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  // Tracked separately so the button label reflects what is actually running
  // rather than reporting "Probing..." during an unrelated mode switch.
  const [probing, setProbing] = useState(false)
  const aliveRef = useRef(true)

  const refresh = async () => {
    try {
      const [cfg, target] = await Promise.all([
        window.clui.gatewayConfigGet(),
        window.clui.getConnectionTarget(),
      ])
      if (!aliveRef.current) return
      setConfig(cfg)
      setMode(target.mode)
    } catch {
      if (aliveRef.current) onLog('Failed to read gateway configuration')
    }
  }

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    return () => { aliveRef.current = false }
  }, [])

  const applyMode = async (next: import('../../shared/types').ConnectionMode) => {
    if (busy) return
    setBusy(true)
    try {
      if (next === 'gateway') {
        if (!config?.remoteUrl) {
          onLog('No remote gateway URL configured — set gateway.remote.url first')
          return
        }
        // Persist the mode the CLI reads, then set the explicit run target.
        const saved = await window.clui.gatewayConfigSet({ mode: 'remote' })
        if (!saved.ok) { onLog(`Gateway config update failed: ${saved.error}`); return }
        const res = await window.clui.setConnectionTarget({ mode: 'gateway', url: config.remoteUrl })
        if (!res.ok) { onLog(`Connection failed: ${res.error}`); return }
      } else {
        if (next === 'local') await window.clui.gatewayConfigSet({ mode: 'local' })
        const res = await window.clui.setConnectionTarget({ mode: next })
        if (!res.ok) { onLog(`Connection failed: ${res.error}`); return }
      }
      setMode(next)
      onLog(`Connection target set to ${next}`)
      await refresh()
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const testConnection = async () => {
    if (busy) return
    setBusy(true)
    setProbing(true)
    onLog('Probing gateway...')
    try {
      const res = await window.clui.gatewayProbe()
      if (!aliveRef.current) return
      setProbe(res)
      onLog(
        res.reachable
          ? `Gateway reachable — capability: ${res.capability || 'unknown'}`
          : 'Gateway unreachable',
      )
    } catch {
      if (aliveRef.current) onLog('Gateway probe failed')
    } finally {
      if (aliveRef.current) {
        setBusy(false)
        setProbing(false)
      }
    }
  }

  const tone = !probe ? 'idle' : !probe.reachable ? 'bad' : probe.missingOperatorScope ? 'warn' : 'ok'

  return (
    <Card title="Connection" colors={colors}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: colors.textSecondary }}>
          <StatusDot tone={tone} />
          {!probe ? 'Not tested' : !probe.reachable ? 'Unreachable' : probe.missingOperatorScope ? 'Connected — limited scope' : 'Connected'}
        </div>

        <div style={{ display: 'flex', gap: 5 }}>
          {(['auto', 'local', 'gateway'] as const).map((m) => (
            <button
              key={m}
              disabled={busy}
              onClick={() => { void applyMode(m) }}
              style={{
                fontSize: 10,
                fontWeight: 600,
                borderRadius: 999,
                padding: '3px 9px',
                cursor: busy ? 'default' : 'pointer',
                fontFamily: 'inherit',
                border: `1px solid ${mode === m ? colors.accent : colors.containerBorder}`,
                background: mode === m ? colors.accentLight : colors.surfacePrimary,
                color: mode === m ? colors.accent : colors.textSecondary,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {m === 'auto' ? 'Auto' : m === 'local' ? 'Local' : 'Remote'}
            </button>
          ))}
        </div>

        <Field label="URL" value={config?.remoteUrl || '(not configured)'} colors={colors} />
        <Field label="Config mode" value={config?.mode || '(unset — resolves to local)'} colors={colors} />
        <Field
          label="Token"
          value={
            config?.tokenRef
              ? `${config.tokenRef.id} ${config.tokenResolvable ? '✓ resolved' : '✗ not set'}`
              : '(none)'
          }
          colors={colors}
        />

        {probe?.missingOperatorScope && (
          <div style={{ fontSize: 10, color: '#f59e0b', lineHeight: 1.45 }}>
            Credential connects but lacks operator scope — chat will be rejected. Grant
            operator.read/operator.write on the gateway, or pair this device.
          </div>
        )}

        <div style={{ marginTop: 2 }}>
          <Action
            onClick={() => { void testConnection() }}
            label={probing ? 'Probing...' : 'Test Connection'}
            icon={<Heartbeat size={11} />}
            colors={colors}
            disabled={busy}
          />
        </div>
      </div>
    </Card>
  )
}

/** This machine's node host service — the process that lets the gateway reach it. */
function NodeHostCard({ colors, onLog }: { colors: Colors; onLog: (line: string) => void }) {
  const [status, setStatus] = useState<import('../../shared/types').NodeHostStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  const refresh = async () => {
    try {
      const next = await window.clui.nodeStatus()
      if (aliveRef.current) setStatus(next)
    } catch {
      if (aliveRef.current) onLog('Failed to read node host status')
    }
  }

  /**
   * How often to ask for node host status.
   *
   * The call itself is cached in main, so most of these are free — this is
   * only how often a *stale* read is allowed to trigger a real `node status`
   * spawn behind it. The old 15s loop fired a ~7s CLI process four times a
   * minute for the entire time this panel was open, to watch a Windows service
   * that changes only when the user presses one of the buttons below it.
   */
  const POLL_MS = 60_000

  // Self-scheduling rather than setInterval: a cache miss shells out to the
  // CLI and takes seconds, so a fixed interval would overlap calls and queue
  // them without bound. Re-arm only after the previous one settles.
  useEffect(() => {
    aliveRef.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const loop = async () => {
      // A hidden launcher has no one looking at this card; skip the tick
      // rather than keep a background poll alive against the CLI.
      if (!document.hidden) await refresh()
      if (!aliveRef.current) return
      timer = setTimeout(() => { void loop() }, POLL_MS)
    }
    void loop()

    // Main serves a stale value immediately and refreshes behind it, so the
    // fresh answer arrives here rather than at the call site.
    const unsub = window.clui.onNodeStatusUpdate((next) => {
      if (aliveRef.current) setStatus(next)
    })

    return () => {
      aliveRef.current = false
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [])

  const act = async (action: import('../../shared/types').NodeAction) => {
    if (busy) return
    setBusy(true)
    onLog(`node ${action}...`)
    try {
      const res = await window.clui.nodeAction(action)
      onLog(res.ok ? `node ${action} succeeded` : `node ${action} failed: ${res.error}`)
      await refresh()
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const tone = !status ? 'idle' : status.running ? 'ok' : status.installed ? 'warn' : 'bad'
  const label = !status
    ? 'Checking...'
    : status.running
      ? `Running${status.pid ? ` (pid ${status.pid})` : ''}`
      : status.installed
        ? 'Installed — stopped'
        : 'Not installed'

  return (
    <Card title="Node Host" colors={colors}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: colors.textSecondary }}>
          <StatusDot tone={tone} />
          {label}
        </div>

        <Field label="Name" value={status?.displayName || '(unregistered)'} colors={colors} />
        <Field
          label="Gateway"
          value={status?.gatewayHost ? `${status.gatewayHost}:${status.gatewayPort ?? 443}${status.tls ? ' (TLS)' : ''}` : '(none)'}
          colors={colors}
        />
        <Field label="Service" value={status?.serviceKind || '(none)'} colors={colors} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
          {status?.running
            ? <Action onClick={() => { void act('stop') }} label="Stop" icon={<Stop size={11} />} colors={colors} disabled={busy} />
            : <Action onClick={() => { void act('start') }} label="Start" icon={<Play size={11} />} colors={colors} disabled={busy} />}
          <Action onClick={() => { void act('restart') }} label="Restart" icon={<ArrowsClockwise size={11} />} colors={colors} disabled={busy} />
          {!status?.installed && (
            <Action onClick={() => { void act('install') }} label="Install" icon={<Sparkle size={11} />} colors={colors} disabled={busy} />
          )}
        </div>
      </div>
    </Card>
  )
}

function Card({ title, children, colors }: { title: string; children: React.ReactNode; colors: ReturnType<typeof useColors> }) {
  return (
    <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 12, background: colors.surfaceHover, padding: 11 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: colors.textPrimary, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function Action({ onClick, label, icon, colors, disabled = false }: {
  onClick: () => void
  label: string
  icon: React.ReactNode
  colors: ReturnType<typeof useColors>
  /** Blocks the click outright — dimming alone still lets queued clicks
   *  spawn duplicate CLI processes (e.g. two concurrent `node install`). */
  disabled?: boolean
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        fontSize: 11,
        fontWeight: 600,
        border: `1px solid ${colors.containerBorder}`,
        background: colors.surfacePrimary,
        color: colors.textSecondary,
        borderRadius: 8,
        padding: '6px 9px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function TabBtn({ active, label, icon, onClick, colors }: {
  active: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
  colors: ReturnType<typeof useColors>
}) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      style={{
        fontSize: 12,
        fontWeight: 600,
        border: `1px solid ${active ? colors.accent : colors.containerBorder}`,
        background: active ? colors.accentLight : colors.surfacePrimary,
        color: active ? colors.accent : colors.textSecondary,
        borderRadius: 999,
        padding: '6px 11px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'inherit',
      }}
    >
      {icon}
      {label}
    </motion.button>
  )
}
