import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { motion } from 'framer-motion'
import { Clock, ChatCircle, CloudArrowDown } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { gatewaySessionLabel } from '../../shared/session-keys'
import type { SessionMeta, GatewaySessionMeta, GatewaySessionListResult } from '../../shared/types'

function formatTimeAgo(isoDate: string): string {
  const parsed = new Date(isoDate).getTime()
  // An absent or unparseable timestamp rendered as "NaNm ago".
  if (!Number.isFinite(parsed)) return ''
  const diff = Date.now() - parsed
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(isoDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** A count of turns is the only size a gateway session has — it owns no file. */
function formatTokens(total: number | null): string {
  if (!total || !Number.isFinite(total)) return ''
  if (total < 1000) return `${total} tok`
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`
}

export function HistoryPicker() {
  const resumeSession = useSessionStore((s) => s.resumeSession)
  const resumeGatewaySession = useSessionStore((s) => s.resumeGatewaySession)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  // Zustand 5 ignores a second `equalityFn` argument, so the field comparison
  // this used to pass never ran. Select the two fields instead.
  const activeTab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return { hasChosenDirectory: t?.hasChosenDirectory, workingDirectory: t?.workingDirectory }
    }),
  )
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const effectiveProjectPath = activeTab?.hasChosenDirectory
    ? activeTab.workingDirectory
    : (staticInfo?.homePath || activeTab?.workingDirectory || '~')

  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  // Separate state on purpose. The local list is a filesystem read that returns
  // in milliseconds; the gateway list is a CLI round trip that can take
  // seconds. Sharing state would make the fast list wait on the slow one, and
  // sharing an array would put a remote failure in a position to empty it.
  const [gateway, setGateway] = useState<GatewaySessionListResult | null>(null)
  const [gatewayLoading, setGatewayLoading] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    if (isExpanded) {
      const top = rect.bottom + 6
      setPos({
        top,
        right: window.innerWidth - rect.right,
        maxHeight: window.innerHeight - top - 12,
      })
    } else {
      setPos({
        bottom: window.innerHeight - rect.top + 6,
        right: window.innerWidth - rect.right,
      })
    }
  }, [isExpanded])

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.clui.listSessions(effectiveProjectPath)
      // Trust nothing off the wire. A row without a usable sessionId cannot be
      // rendered or resumed, and one such row used to throw during render and
      // unmount the entire app — the launcher went blank and never came back.
      setSessions(
        (Array.isArray(result) ? result : []).filter(
          (s): s is SessionMeta => !!s && typeof s.sessionId === 'string' && s.sessionId.length > 0,
        ),
      )
    } catch {
      setSessions([])
    }
    setLoading(false)
  }, [effectiveProjectPath])

  const loadGatewaySessions = useCallback(async () => {
    setGatewayLoading(true)
    try {
      const result = await window.clui.listGatewaySessions()
      // Same distrust as the local list, for the same reason: a row without a
      // key can be neither rendered nor resumed. A malformed reply — or a shim
      // that predates this method, where the call throws — degrades to "no
      // gateway group" and leaves the local list untouched.
      setGateway(
        result && Array.isArray(result.sessions)
          ? {
              ...result,
              sessions: result.sessions.filter(
                (s): s is GatewaySessionMeta =>
                  !!s && typeof s.sessionKey === 'string' && s.sessionKey.length > 0,
              ),
            }
          : null,
      )
    } catch {
      setGateway(null)
    }
    setGatewayLoading(false)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open) {
      updatePos()
      // Started together, awaited separately — neither can delay the other.
      void loadSessions()
      void loadGatewaySessions()
    }
    setOpen((o) => !o)
  }

  const handleSelect = (session: SessionMeta) => {
    setOpen(false)
    const title = session.firstMessage
      ? (session.firstMessage.length > 30 ? session.firstMessage.substring(0, 27) + '...' : session.firstMessage)
      : session.slug || 'Resumed'
    void resumeSession(session.sessionId, title, effectiveProjectPath)
  }

  const handleSelectGateway = (session: GatewaySessionMeta) => {
    setOpen(false)
    const label = gatewaySessionLabel(session.sessionKey, session.displayName)
    void resumeGatewaySession(session, label.length > 30 ? label.substring(0, 27) + '...' : label)
  }

  // 'unsupported' means there is nothing here to offer — no gateway configured,
  // or one too old to list sessions. That is a normal state, not a failure, so
  // the group is hidden rather than explained.
  const showGatewayGroup =
    gatewayLoading || (!!gateway && (gateway.available || gateway.reason !== 'unsupported'))

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: colors.textTertiary }}
        title="Resume a previous session"
      >
        <Clock size={13} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-clui-ui
          initial={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            ...(pos.top != null ? { top: pos.top } : {}),
            ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
            right: pos.right,
            width: 280,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight } : {}),
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' as const,
          }}
        >
          <div className="px-3 py-2 text-[11px] font-medium flex-shrink-0" style={{ color: colors.textTertiary, borderBottom: `1px solid ${colors.popoverBorder}` }}>
            Recent Sessions
          </div>

          <div className="overflow-y-auto py-1" style={{ maxHeight: pos.maxHeight != null ? undefined : 180 }}>
            {/* The two groups are scoped differently — local is this project,
                gateway is the whole agent — so both are attributed rather than
                presented as one undifferentiated history. */}
            <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide" style={{ color: colors.textTertiary }}>
              This machine
            </div>

            {loading && (
              <div className="px-3 py-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                Loading...
              </div>
            )}

            {!loading && sessions.length === 0 && (
              <div className="px-3 py-3 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                No local sessions found
              </div>
            )}

            {!loading && sessions.map((session) => (
              <button
                key={session.sessionId}
                onClick={() => handleSelect(session)}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors"
              >
                <ChatCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: colors.textTertiary }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] truncate" style={{ color: colors.textPrimary }}>
                    {session.firstMessage || session.slug || (session.sessionId || '').substring(0, 8) || 'Session'}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mt-0.5" style={{ color: colors.textTertiary }}>
                    <span>{formatTimeAgo(session.lastTimestamp)}</span>
                    <span>{formatSize(session.size)}</span>
                    {session.slug && <span className="truncate">{session.slug}</span>}
                  </div>
                </div>
              </button>
            ))}

            {showGatewayGroup && (
              <>
                <div
                  className="px-3 pt-2 pb-1 mt-1 text-[10px] uppercase tracking-wide"
                  style={{ color: colors.textTertiary, borderTop: `1px solid ${colors.popoverBorder}` }}
                >
                  On the gateway
                </div>

                {/* Keyed on `!available`, not on `!gateway`: the popover is
                    never unmounted, so on a reopen after a failure `gateway`
                    still holds the old unavailable result while the refetch is
                    in flight. Testing `!gateway` there left every branch false
                    and drew this header over nothing. A reload after a
                    *success* keeps its rows instead, which also avoids a
                    flicker back to a spinner. */}
                {gatewayLoading && !gateway?.available && (
                  <div className="px-3 py-3 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                    Checking gateway...
                  </div>
                )}

                {!gatewayLoading && gateway && !gateway.available && (
                  <div className="px-3 py-3 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                    {gateway.error || 'Gateway sessions unavailable'}
                  </div>
                )}

                {gateway?.available && gateway.sessions.length === 0 && (
                  <div className="px-3 py-3 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                    No sessions on the gateway
                  </div>
                )}

                {gateway?.available && gateway.sessions.map((session) => (
                  <button
                    key={session.sessionKey}
                    onClick={() => handleSelectGateway(session)}
                    className="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors"
                  >
                    <CloudArrowDown size={13} className="flex-shrink-0 mt-0.5" style={{ color: colors.textTertiary }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] truncate" style={{ color: colors.textPrimary }}>
                        {gatewaySessionLabel(session.sessionKey, session.displayName)}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] mt-0.5" style={{ color: colors.textTertiary }}>
                        {session.lastTimestamp && <span>{formatTimeAgo(session.lastTimestamp)}</span>}
                        {formatTokens(session.totalTokens) && <span>{formatTokens(session.totalTokens)}</span>}
                        {session.hasActiveRun && <span>running</span>}
                        {session.model && <span className="truncate">{session.model}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
