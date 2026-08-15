import React, { useEffect, useCallback, useMemo, useState } from 'react'
import { motion, AnimatePresence, MotionGlobalConfig } from 'framer-motion'
import { Paperclip, Camera, HeadCircuit, Sparkle, Wrench } from '@phosphor-icons/react'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { MarketplacePanel } from './components/MarketplacePanel'
import { OnboardingPanel } from './components/OnboardingPanel'
import { ControlCenterPanel } from './components/ControlCenterPanel'
import { SkillBuilderPanel } from './components/SkillBuilderPanel'
import { GuidedTourOverlay, type TourStep } from './components/GuidedTourOverlay'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useWorkingMonitor } from './hooks/useWorkingMonitor'
import { useSessionStore } from './stores/sessionStore'
import { useColors, useThemeStore, panelMetrics, usePanelWidth } from './theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

/**
 * How long to wait for the shell's layout to stop changing before telling main
 * it may reveal the window. Must exceed TRANSITION (260ms) so a shell mid-tween
 * is never revealed, and must stay under the main-side watchdog
 * (PRESENT_ACK_TIMEOUT_MS) so the ack still wins the race in the normal case.
 */
const SETTLE_CAP_MS = 320

/**
 * The summon entrance and exit, owned by the renderer.
 *
 * The window is no longer hidden between summons — it parks off-screen — so
 * its compositor stays live and these play on a surface that is already warm.
 * That is what makes a launcher entrance viable at all here: the earlier
 * attempts fought a renderer that was being torn down.
 *
 * Opacity and a small rise, no scale: the exit has to finish before main parks
 * the window, so it is kept shorter than the entrance to stay responsive.
 * Durations are paired with DISMISS_ACK_TIMEOUT_MS in the main process.
 */
const SUMMON_IN = { duration: 0.16, ease: [0.16, 1, 0.3, 1] as const }
const SUMMON_OUT = { duration: 0.11, ease: [0.4, 0, 1, 1] as const }
/** Exit duration in ms, plus a frame, before telling main it may park. */
const SUMMON_OUT_MS = 130

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()
  useWorkingMonitor()

  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const colors = useColors()
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const panelWidth = usePanelWidth()
  const [showOnboarding, setShowOnboarding] = useState(false)
  // Drives the summon entrance/exit. Starts true so the launcher is present on
  // first paint at startup, where there is nothing to animate in from.
  const [onScreen, setOnScreen] = useState(true)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [tourStep, setTourStep] = useState(0)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const controlCenterOpen = useSessionStore((s) => s.controlCenterOpen)
  const skillBuilderOpen = useSessionStore((s) => s.skillBuilderOpen)
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // ─── Theme initialization ───
  useEffect(() => {
    // Get initial OS theme — setSystemTheme respects themeMode (system/light/dark)
    window.clui.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    // Listen for OS theme changes
    const unsub = window.clui.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])

  useEffect(() => {
    void useSessionStore.getState().initStaticInfo().then(() => {
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'
      const tab = useSessionStore.getState().tabs[0]
      if (tab) {
        // Set working directory to home by default (user hasn't chosen yet)
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, workingDirectory: homeDir, hasChosenDirectory: false } : t)),
        }))
        window.clui.createTab().then(({ tabId }) => {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, id: tabId } : t)),
            activeTabId: tabId,
          }))
        }).catch(() => {})
      }

      const info = useSessionStore.getState().staticInfo
      const complete = localStorage.getItem('openclaw-onboarding-complete') === '1'
      const dismissed = localStorage.getItem('openclaw-onboarding-dismissed') === '1'
      const seen = localStorage.getItem('openclaw-onboarding-seen') === '1'
      const needsOnboarding = !!info && !complete && !dismissed && !seen
      if (needsOnboarding) {
        localStorage.setItem('openclaw-onboarding-seen', '1')
      }
      setShowOnboarding(needsOnboarding)
    })
  }, [])

  // Update check: never on the launch path. It spawns the CLI (~4s) and hits
  // the network, and the answer is the same all week — so let the launcher
  // settle first, and let the store's own once-a-day throttle decide whether
  // it runs at all.
  useEffect(() => {
    const t = setTimeout(() => {
      void useSessionStore.getState().maybeCheckOpenclawUpdate()
    }, 45_000)
    return () => clearTimeout(t)
  }, [])

  // Every time the launcher is shown again, start from chat-only mode.
  useEffect(() => {
    const unsubShown = window.clui.onWindowShown(() => {
      // Re-enable motion BEFORE flipping onScreen, so the entrance is created
      // as a real animation rather than snapped like the layout was.
      // CLUI_NO_ANIM stays authoritative.
      if (!window.__cluiNoAnim) MotionGlobalConfig.skipAnimations = false
      setOnScreen(true)
    })

    const unsubDismiss = window.clui.onWindowDismiss((generation) => {
      // Play the exit, then let main park the window. Main also runs its own
      // watchdog, so a missed ack costs a snap, never a stuck launcher.
      if (!window.__cluiNoAnim) MotionGlobalConfig.skipAnimations = false
      setOnScreen(false)
      setTimeout(() => window.clui.dismissReady(generation), SUMMON_OUT_MS)
    })

    const unsubPrepare = window.clui.onWindowPrepare((generation) => {
      // Runs while the window is still HIDDEN. Everything that changes layout
      // on summon belongs here, so the first visible frame is already correct.
      //
      // Animate nothing during a summon. Two recordings showed the bar
      // assembling on screen — 48x9 -> 646x53 -> 663x56 -> 700x89 over ~200ms
      // — because tweens were still resolving when the window was revealed.
      // A launcher's entrance is not the place for motion: the user asked for
      // it, and it should simply be there, finished.
      //
      // skipAnimations is checked before an animation is created, so anything
      // this handler triggers (closeAuxPanels, and the layout that follows)
      // resolves straight to its final keyframe. Anything already in flight
      // from before the hide is handled by the settle gate below.
      MotionGlobalConfig.skipAnimations = true
      useSessionStore.getState().closeAuxPanels()
      // Snap to the entrance start state while still off screen, so the
      // entrance has somewhere to animate from and none of it is spent unseen.
      setOnScreen(false)

      // Ack when the layout has actually stopped moving.
      //
      // This used to ack after two rAFs, which proves React committed and
      // painted — but not that layout settled. The shell's width/height
      // animations and framer's measurement of `height: 'auto'` can still be
      // resolving, so the window was revealed into a half-built layout and the
      // user watched the bar assemble: measured at 48x9 -> 646x53 -> 663x56 ->
      // 700x89 over ~200ms, in two independent screen recordings.
      //
      // Wait for the shell's rect to repeat across consecutive frames instead,
      // capped so a permanently-animating UI can still be summoned.
      const settleStart = performance.now()
      let stableFrames = 0
      let lastSig = ''
      const settle = (): void => {
        const el = document.querySelector('[data-clui-shell]')
        const r = el?.getBoundingClientRect()
        const sig = r ? `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.y)}` : 'none'
        stableFrames = sig === lastSig ? stableFrames + 1 : 0
        lastSig = sig
        if (stableFrames >= 3 || performance.now() - settleStart > SETTLE_CAP_MS) {
          window.clui.windowReady(generation)
          return
        }
        requestAnimationFrame(settle)
      }
      requestAnimationFrame(settle)

    })

    return () => { unsubShown(); unsubPrepare(); unsubDismiss() }
  }, [])

  const onboardingInfo = useMemo(() => {
    if (!staticInfo) return null
    return {
      version: staticInfo.version,
      email: staticInfo.email,
      homePath: staticInfo.homePath,
      cliCommand: staticInfo.cliCommand,
      authSupported: staticInfo.authSupported,
    }
  }, [staticInfo])

  useEffect(() => {
    const handler = () => setShowOnboarding(true)
    window.addEventListener('openclaw:show-onboarding', handler)
    return () => window.removeEventListener('openclaw:show-onboarding', handler)
  }, [])

  useEffect(() => {
    return window.clui.onShortcutAction((action) => {
      if (action === 'toggle-marketplace') {
        useSessionStore.getState().toggleMarketplace()
        return
      }
      if (action === 'open-agents') {
        useSessionStore.getState().openControlCenter('agents')
        return
      }
      if (action === 'open-settings') {
        useSessionStore.getState().openControlCenter('settings')
      }
    })
  }, [])

  const tourSteps = useMemo<TourStep[]>(() => ([
    {
      id: 'tabs',
      title: 'Tabs & Sessions',
      body: 'Use tabs to manage separate OpenClaw sessions. Click a tab to focus, or create a new one.',
      selector: '[data-tour=\"tabs\"]',
    },
    {
      id: 'input',
      title: 'Prompt Input',
      body: 'Type prompts here, add attachments, and run slash commands like /model or /skills.',
      selector: '[data-tour=\"input\"]',
    },
    {
      id: 'quick-settings',
      title: 'Quick Settings',
      body: 'Open quick settings to switch theme, resize the panel, and access OpenClaw checks.',
      selector: '[data-tour=\"settings-trigger\"]',
    },
    {
      id: 'left-actions',
      title: 'Top Action Bar',
      body: 'These actions handle files, screenshots, Control Center, and community skill sets.',
      selector: '[data-tour=\"left-actions\"]',
    },
    {
      id: 'marketplace',
      title: 'Community Skills',
      body: 'Browse and install native or ClawHub skills from the Skills Marketplace.',
      selector: '[data-tour=\"marketplace-panel\"]',
    },
    {
      id: 'control-center',
      title: 'Agent Control Center',
      body: 'Use this full panel to run OpenClaw commands and manage provider/model settings.',
      selector: '[data-tour=\"control-center-panel\"]',
    },
  ]), [])

  useEffect(() => {
    if (!tourOpen) return
    const current = tourSteps[tourStep]?.id
    if (current === 'marketplace' && !marketplaceOpen) useSessionStore.getState().toggleMarketplace()
    if (current !== 'marketplace' && marketplaceOpen) useSessionStore.getState().closeMarketplace()
    if (current === 'control-center' && !controlCenterOpen) useSessionStore.getState().openControlCenter('agents')
    if (current !== 'control-center' && controlCenterOpen) useSessionStore.getState().closeControlCenter()
  }, [tourOpen, tourStep, tourSteps, marketplaceOpen, controlCenterOpen])

  // OS-level click-through.
  //
  // document.elementFromPoint() forces a synchronous style + layout flush, so
  // running it on every mousemove stalls the compositor — worst exactly when
  // the pointer sweeps toward a window that is mid-entrance-animation. Sample
  // at most once per frame instead, and skip entirely if the pointer has not
  // actually moved to a new position.
  useEffect(() => {
    if (!window.clui?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null
    let pending: number | null = null
    let lastX = -1
    let lastY = -1
    let nextX = 0
    let nextY = 0

    const sample = () => {
      pending = null
      if (nextX === lastX && nextY === lastY) return
      lastX = nextX
      lastY = nextY

      const el = document.elementFromPoint(nextX, nextY)
      const isUI = !!(el && el.closest('[data-clui-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.clui.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.clui.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      nextX = e.clientX
      nextY = e.clientY
      if (pending === null) pending = requestAnimationFrame(sample)
    }

    const onMouseLeave = () => {
      if (lastIgnored !== true) {
        lastIgnored = true
        window.clui.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      if (pending !== null) cancelAnimationFrame(pending)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  // Keep window open while dragging files over it (prevents blur auto-hide).
  useEffect(() => {
    const hasFiles = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types || [])
      return types.includes('Files')
    }
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      setDraggingFiles(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDraggingFiles(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (e.relatedTarget == null) setDraggingFiles(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      setDraggingFiles(false)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => {
    window.clui.setDragHolding(draggingFiles)
  }, [draggingFiles])

  // Layout dimensions — the chosen panel width drives the column, the card, and
  // the heights that go with it (see panelMetrics).
  const metrics = panelMetrics(panelWidth)
  const contentWidth = panelWidth
  const cardExpandedWidth = panelWidth
  const cardCollapsedWidth = metrics.collapsedWidth
  const cardCollapsedMargin = 15

  // The column is bottom-anchored inside a fixed-height window, so anything
  // that does not fit is clipped off the TOP — where the takeover panels live.
  // When one is open the conversation yields most of its height to it, and the
  // panel itself is additionally capped to the viewport.
  const takeoverOpen = controlCenterOpen || marketplaceOpen || skillBuilderOpen
  const bodyMaxHeight = takeoverOpen ? 150 : metrics.bodyMaxHeight
  // The 300px reserve is the column below a takeover panel: the shell card
  // (~200 at bodyMaxHeight), the input row (~60), and the panel's own margin.
  // The ceiling is what the panels are designed for; `100vh` is what the shell
  // could actually give, which on a short screen is less.
  const panelMaxHeight = 'min(640px, calc(100vh - 300px))'
  const marketplaceMaxHeight = 'min(560px, calc(100vh - 300px))'

  const handleScreenshot = useCallback(async () => {
    const result = await window.clui.takeScreenshot()
    if (!result) return
    addAttachments([result])
  }, [addAttachments])

  const handleAttachFile = useCallback(async () => {
    const files = await window.clui.attachFiles()
    if (!files || files.length === 0) return
    addAttachments(files)
  }, [addAttachments])

  const handlePickWorkspace = useCallback(async () => {
    const dir = await window.clui.selectDirectory()
    if (dir) setBaseDirectory(dir)
  }, [setBaseDirectory])

  return (
    <PopoverLayerProvider>
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <motion.div
          animate={{ opacity: onScreen ? 1 : 0, y: onScreen ? 0 : 10 }}
          transition={onScreen ? SUMMON_IN : SUMMON_OUT}
          style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}
        >

          {showOnboarding && onboardingInfo && (
            <div
              data-clui-ui
              style={{
                width: metrics.onboardingWidth,
                maxWidth: 720,
                marginLeft: '50%',
                transform: 'translateX(-50%)',
              }}
            >
              <OnboardingPanel
                info={onboardingInfo}
                onOpenTerminal={() => { void window.clui.openInTerminal(null, onboardingInfo.homePath) }}
                onPickWorkspace={handlePickWorkspace}
                onOpenMarketplace={() => useSessionStore.getState().toggleMarketplace()}
                onOpenControlCenter={() => useSessionStore.getState().openControlCenter('settings')}
                onStartTour={() => {
                  setShowOnboarding(false)
                  setTourStep(0)
                  setTourOpen(true)
                }}
                onDismiss={() => {
                  localStorage.setItem('openclaw-onboarding-dismissed', '1')
                  setShowOnboarding(false)
                }}
              />
            </div>
          )}

          <AnimatePresence initial={false}>
            {controlCenterOpen && (
              <div
                data-clui-ui
                data-tour="control-center-panel"
                style={{
                  width: 1040,
                  maxWidth: 1040,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 31,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-clui-ui
                    className="glass-surface overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: panelMaxHeight,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <ControlCenterPanel />
                  </div>
                </motion.div>
              </div>
            )}

            {marketplaceOpen && (
              <div
                data-clui-ui
                data-tour="marketplace-panel"
                style={{
                  width: 860,
                  maxWidth: 860,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 30,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-clui-ui
                    className="glass-surface overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: marketplaceMaxHeight,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <MarketplacePanel />
                  </div>
                </motion.div>
              </div>
            )}

            {skillBuilderOpen && (
              <div
                data-clui-ui
                style={{
                  width: 1040,
                  maxWidth: 1040,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 31,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-clui-ui
                    className="glass-surface overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: panelMaxHeight,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <SkillBuilderPanel />
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/*
            ─── Tabs / message shell ───
            This always remains the chat shell. The marketplace is a separate
            panel rendered above it, never inside it.
          */}
          <motion.div
            data-clui-ui
            data-clui-shell
            className="overflow-hidden flex flex-col drag-region"
            animate={{
              width: isExpanded ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded ? 10 : -14,
              marginLeft: isExpanded ? 0 : cardCollapsedMargin,
              marginRight: isExpanded ? 0 : cardCollapsedMargin,
              background: isExpanded ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded ? 20 : 10,
            }}
            onDragEnter={() => setDraggingFiles(true)}
            onDragLeave={(e) => { if ((e.relatedTarget as Node | null) === null) setDraggingFiles(false) }}
            onDrop={() => setDraggingFiles(false)}
            onDragOver={(e) => e.preventDefault()}
          >
            {/* Top row: tabs + action controls */}
            <div
              className="no-drag"
              style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 8 }}
            >
              <div data-tour="tabs" style={{ flex: 1, minWidth: 0 }}>
                <TabStrip />
              </div>
              <div data-tour="left-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="glass-surface"
                  title="Attach file"
                  onClick={handleAttachFile}
                  disabled={isRunning}
                  style={topActionBtnStyle(colors, isRunning)}
                >
                  <Paperclip size={16} />
                </button>
                <button
                  className="glass-surface"
                  title="Take screenshot"
                  onClick={handleScreenshot}
                  disabled={isRunning}
                  style={topActionBtnStyle(colors, isRunning)}
                >
                  <Camera size={16} />
                </button>
                <button
                  className="glass-surface"
                  title="OpenClaw Control Center"
                  onClick={() => useSessionStore.getState().openControlCenter('agents')}
                  disabled={isRunning}
                  style={topActionBtnStyle(colors, isRunning)}
                >
                  <HeadCircuit size={16} />
                </button>
                <button
                  className="glass-surface"
                  title="Community Skill Sets"
                  onClick={() => useSessionStore.getState().toggleMarketplace()}
                  disabled={isRunning}
                  style={topActionBtnStyle(colors, isRunning)}
                >
                  <Sparkle size={16} />
                </button>
                <button
                  className="glass-surface"
                  title="Visual Skill Builder"
                  onClick={() => useSessionStore.getState().toggleSkillBuilder()}
                  disabled={isRunning}
                  style={topActionBtnStyle(colors, isRunning)}
                >
                  <Wrench size={16} />
                </button>
              </div>
            </div>

            {/* Body — chat history only; the marketplace is a separate overlay above */}
            <motion.div
              initial={false}
              animate={{
                height: isExpanded ? 'auto' : 0,
                opacity: isExpanded ? 1 : 0,
              }}
              transition={TRANSITION}
              className="overflow-hidden no-drag"
            >
              <div style={{ maxHeight: bodyMaxHeight }}>
                <ConversationView />
                <StatusBar />
              </div>
            </motion.div>
          </motion.div>

          {/* Input row */}
          <div data-clui-ui className="relative" style={{ minHeight: 46, zIndex: 25, marginBottom: 10 }}>
            {/* Input pill */}
            <div
              data-clui-ui
              data-tour="input"
              className="glass-surface w-full"
              style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg }}
            >
              <InputBar />
            </div>
          </div>
        </motion.div>
      </div>
      <GuidedTourOverlay
        open={tourOpen}
        steps={tourSteps}
        stepIndex={tourStep}
        onPrev={() => setTourStep((s) => Math.max(0, s - 1))}
        onNext={() => {
          if (tourStep >= tourSteps.length - 1) {
            setTourOpen(false)
            localStorage.setItem('openclaw-onboarding-complete', '1')
            localStorage.setItem('openclaw-onboarding-dismissed', '1')
            return
          }
          setTourStep((s) => Math.min(tourSteps.length - 1, s + 1))
        }}
        onClose={() => setTourOpen(false)}
      />
    </PopoverLayerProvider>
  )
}

function topActionBtnStyle(colors: ReturnType<typeof useColors>, disabled: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: 999,
    border: `1px solid ${colors.containerBorder}`,
    background: colors.surfacePrimary,
    color: disabled ? colors.textTertiary : colors.textSecondary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}
