import React, { useState, useMemo, useCallback, useRef, useEffect, useDeferredValue } from 'react'
import { motion } from 'framer-motion'
import { X, MagnifyingGlass, SpinnerGap, ArrowClockwise, HeadCircuit, Compass, GithubLogo } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import type { CatalogPlugin, PluginStatus } from '../../shared/types'

/**
 * How many cards are mounted at once, and how many more each time the reader
 * reaches the bottom.
 *
 * The catalogue is not small — the community feed alone is capped at 1400
 * entries — and every card is a `layout` motion component, so framer measures
 * and re-projects each one on every commit. Rendering the whole list put ~21k
 * nodes in the DOM and made a single keystroke in the search box cost 180-330ms
 * of blocking main-thread work; with the launcher being a transparent
 * always-on-top window, that stall is visible system-wide, not just in the app.
 */
const PAGE_SIZE = 40

export function MarketplacePanel() {
  const colors = useColors()
  const catalog = useSessionStore((s) => s.marketplaceCatalog)
  const loading = useSessionStore((s) => s.marketplaceLoading)
  const error = useSessionStore((s) => s.marketplaceError)
  const pluginStates = useSessionStore((s) => s.marketplacePluginStates)
  const search = useSessionStore((s) => s.marketplaceSearch)
  const filter = useSessionStore((s) => s.marketplaceFilter)
  const closeMarketplace = useSessionStore((s) => s.closeMarketplace)
  const setSearch = useSessionStore((s) => s.setMarketplaceSearch)
  const setFilter = useSessionStore((s) => s.setMarketplaceFilter)
  const loadMarketplace = useSessionStore((s) => s.loadMarketplace)
  const buildYourOwn = useSessionStore((s) => s.buildYourOwn)
  // Selected once here rather than inside every card: these are stable zustand
  // actions, and a per-card selector would add two store subscriptions per row
  // that fire on every unrelated state change (including each streaming token).
  const installPlugin = useSessionStore((s) => s.installMarketplacePlugin)
  const uninstallPlugin = useSessionStore((s) => s.uninstallMarketplacePlugin)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Derive filter chips dynamically from catalog semantic tags, sorted by frequency
  const filters = useMemo(() => {
    const tagCounts = new Map<string, number>()
    for (const p of catalog) {
      for (const t of (p.tags || [])) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
      }
    }
    // Sort by frequency (descending), then alphabetically
    const sorted = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
    // 'All' and 'Installed' are special chips, not tags. Deduped so a catalogue
    // tag that happens to share their text cannot produce two chips with the
    // same React key — and the special one keeps its meaning.
    return [...new Set(['All', ...sorted, 'Installed'])]
  }, [catalog])

  // Debounced search
  const [localSearch, setLocalSearch] = useState(search)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setLocalSearch(val)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setSearch(val), 200)
  }, [setSearch])

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // Keeps the caret responsive: the input paints from localSearch immediately,
  // and React re-filters the (large) list against the deferred value at lower
  // priority. The debounce above only syncs the store, which nothing on this
  // render path reads — so it never did any filtering work on its own.
  const deferredSearch = useDeferredValue(localSearch)

  // One lowercased haystack per plugin, rebuilt only when the catalogue does.
  // Doing this per keystroke meant six toLowerCase() calls across every entry.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of catalog) {
      const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : []
      // NUL-joined so a match can never straddle two fields.
      m.set(p.id, [p.name, p.description, ...tags, p.author, p.repo, p.marketplace]
        .filter(Boolean).join('\u0000').toLowerCase())
    }
    return m
  }, [catalog])

  // Filtered plugins
  const filtered = useMemo(() => {
    const q = deferredSearch.toLowerCase()
    return catalog.filter((p) => {
      if (q && !(haystacks.get(p.id) ?? '').includes(q)) return false
      if (filter === 'All') return true
      if (filter === 'Installed') return pluginStates[p.id] === 'installed'
      return Array.isArray(p.tags) && p.tags.includes(filter)
    })
  }, [catalog, haystacks, deferredSearch, filter, pluginStates])

  // ─── Windowed rendering ───
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // A new result set starts from the top again. Adjusted during render rather
  // than in an effect so the collapsed window is what actually gets committed
  // — an effect would paint the previous, longer list for a frame first.
  const resultKey = `${deferredSearch}\u0000${filter}`
  const [lastResultKey, setLastResultKey] = useState(resultKey)
  if (resultKey !== lastResultKey) {
    setLastResultKey(resultKey)
    setVisibleCount(PAGE_SIZE)
  }

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 })
  }, [resultKey])

  const hasMore = visibleCount < filtered.length

  /**
   * Grow the window as the reader nears the bottom.
   *
   * A scroll check rather than an IntersectionObserver on purpose: this shell
   * parks its window off-screen instead of hiding it, and a document that
   * reports `visibilityState: 'hidden'` stops delivering intersection
   * callbacks entirely — the list would simply stop growing, with nothing to
   * show for it. Scroll events have no such dependency on compositing.
   */
  const totalCount = filtered.length
  const handleBodyScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
    setVisibleCount((c) => (c < totalCount ? c + PAGE_SIZE : c))
  }, [totalCount])

  // Reorder cards so expanded card sits on a full-width row with no grid gaps.
  // If the expanded card was in the right column (odd index), its left neighbor
  // drops below it to fill the next row — no empty cells.
  const displayOrder = useMemo(() => {
    // Slice first: only the mounted window can contain the expanded card, and
    // reordering the full result set would rebuild a 1400-entry array per click.
    const window = filtered.slice(0, visibleCount)
    if (expandedId === null) return window
    const idx = window.findIndex((p) => p.id === expandedId)
    if (idx === -1) return window
    const expanded = window[idx]
    const before = window.slice(0, idx)
    const after = window.slice(idx + 1)
    if (idx % 2 === 1 && before.length > 0) {
      // Odd index (right column): move left neighbor to after the expanded card
      const leftNeighbor = before.pop()!
      return [...before, expanded, leftNeighbor, ...after]
    }
    return [...before, expanded, ...after]
  }, [filtered, visibleCount, expandedId])

  // Stable identity, so a card only re-renders when its own props change.
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id))
  }, [])

  return (
    <div
      data-clui-ui
      style={{
        // Flexes to the parent's available height instead of demanding 470px,
        // which would push the panel off the top of a bottom-anchored window.
        flex: 1,
        minHeight: 0,
        maxHeight: 560,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 18px 10px',
        borderBottom: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <HeadCircuit size={20} weight="regular" style={{ color: colors.accent }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.textPrimary }}>
              Skills Marketplace
            </div>
            <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>
              Install skills and plugins without leaving OpenClaw UI
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: colors.textTertiary }}>
            {filtered.length} result{filtered.length === 1 ? '' : 's'}
          </span>
          <button
            onClick={() => loadMarketplace(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: colors.textTertiary,
              padding: 2,
              display: 'flex',
              borderRadius: 4,
            }}
            title="Refresh marketplace"
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textPrimary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
          >
            <ArrowClockwise size={14} />
          </button>
          <button
            onClick={closeMarketplace}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: colors.textTertiary, padding: 2, display: 'flex',
              borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textPrimary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Search + Build your own */}
      <div style={{ padding: '12px 18px 10px', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: colors.inputPillBg,
          borderRadius: 12,
          padding: '9px 12px',
          border: `1px solid ${colors.containerBorder}`,
          minWidth: 0,
          flex: 1,
        }}>
          <MagnifyingGlass size={13} style={{ color: colors.textTertiary, flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Search skills, tags, authors..."
            value={localSearch}
            onChange={handleSearchChange}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: colors.textPrimary, fontSize: 12, fontFamily: 'inherit',
            }}
          />
        </div>
        <button
          onClick={buildYourOwn}
          style={{
            flexShrink: 0,
            height: 36,
            padding: '0 12px',
            borderRadius: 9999,
            border: `1px dashed ${colors.accentBorderMedium}`,
            background: colors.accentLight,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.15s',
            color: colors.accent,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.accent }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.accentBorderMedium }}
        >
          <Compass size={12} weight="regular" />
          Build your own
        </button>
      </div>

      {/* Filter chips */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '0 18px 12px',
        // Wraps rather than scrolls. The chip set is derived from the catalogue
        // and runs to ~21 entries (1354px of them); in a single scrolling strip
        // with `scrollbar-width: none` the last eleven were simply not visible,
        // and nothing on screen said they existed. Wrapping costs one extra row
        // of height and puts every filter in view.
        flexWrap: 'wrap',
        rowGap: 8,
        // Fixed chrome: it must not flex. It previously did, and because
        // `overflow-x: auto` had made it a scroll container — whose automatic
        // minimum size is 0 — it was the only row here that could shrink to
        // nothing, so it absorbed the whole deficit and collapsed the chips
        // from 31px tall to 14px, clipping their labels.
        flexShrink: 0,
      }}>
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '6px 11px',
              flexShrink: 0,
              borderRadius: 999,
              border: `1px solid ${filter === f ? colors.accent : colors.containerBorder}`,
              background: filter === f ? colors.accentLight : 'transparent',
              color: filter === f ? colors.accent : colors.textSecondary,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Body */}
      <div ref={scrollContainerRef} onScroll={handleBodyScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 18px', scrollbarWidth: 'thin' }}>
        {loading ? (
          <LoadingState colors={colors} />
        ) : error ? (
          <ErrorState error={error} colors={colors} onRetry={() => loadMarketplace(true)} />
        ) : filtered.length === 0 ? (
          <EmptyState colors={colors} />
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                paddingBottom: 6,
              }}
            >
              {displayOrder.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  status={pluginStates[plugin.id] || 'not_installed'}
                  colors={colors}
                  expanded={expandedId === plugin.id}
                  scrollContainerRef={scrollContainerRef}
                  onToggleExpand={handleToggleExpand}
                  installPlugin={installPlugin}
                  uninstallPlugin={uninstallPlugin}
                />
              ))}
            </div>
            {hasMore && (
              <div
                style={{
                  padding: '10px 0 14px',
                  textAlign: 'center',
                  fontSize: 10,
                  color: colors.textTertiary,
                }}
              >
                Loading {filtered.length - visibleCount} more…
              </div>
            )}
          </>
        )}
      </div>

    </div>
  )
}

// ─── PluginCard ───

type StoreActions = ReturnType<typeof useSessionStore.getState>

const PluginCard = React.memo(function PluginCard({
  plugin, status, colors, expanded, onToggleExpand, scrollContainerRef, installPlugin, uninstallPlugin,
}: {
  plugin: CatalogPlugin
  status: PluginStatus
  colors: ReturnType<typeof useColors>
  expanded: boolean
  onToggleExpand: (id: string) => void
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  installPlugin: StoreActions['installMarketplacePlugin']
  uninstallPlugin: StoreActions['uninstallMarketplacePlugin']
}) {
  const [showConfirm, setShowConfirm] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const needsScrollRef = useRef(false)
  const toggleExpand = useCallback(() => onToggleExpand(plugin.id), [onToggleExpand, plugin.id])

  useEffect(() => {
    if (expanded) needsScrollRef.current = true
  }, [expanded])

  const handleLayoutComplete = useCallback(() => {
    if (!needsScrollRef.current || !expanded || !cardRef.current || !scrollContainerRef.current) return
    needsScrollRef.current = false
    const container = scrollContainerRef.current
    const card = cardRef.current
    const containerRect = container.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    // Scroll so the card is vertically centered in the scroll container
    const cardTopRelative = cardRect.top - containerRect.top + container.scrollTop
    const targetScroll = cardTopRelative - (containerRect.height - cardRect.height) / 2
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
  }, [expanded, scrollContainerRef])

  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Already on the gateway — there is nothing to install.
    if (plugin.installMode === 'gateway') return
    if (plugin.installMode === 'clawhub') {
      if (status === 'failed' || status === 'not_installed') void installPlugin(plugin)
      return
    }
    if (status === 'failed') {
      void installPlugin(plugin)
    } else {
      setShowConfirm(true)
      if (!expanded) toggleExpand()
    }
  }

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowConfirm(false)
    void installPlugin(plugin)
  }

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowConfirm(false)
  }

  const handleGithubClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = `https://github.com/${plugin.repo || 'unknown/repo'}/tree/main/${plugin.sourcePath || ''}`
    void window.clui.openExternal(url)
  }

  // Collapse → clear confirm
  useEffect(() => {
    if (!expanded) setShowConfirm(false)
  }, [expanded])

  const safeName = plugin.name || 'Unnamed plugin'
  const safeDescription = plugin.description || 'No description provided.'
  const safeCategory = plugin.category || 'Other'
  const safeMarketplace = plugin.marketplace || 'Marketplace'
  const safeMarketplaceSlug = (plugin.repo || '').split('/').pop() || safeMarketplace
  const safeAuthor = plugin.author || 'Unknown'
  const safeRepo = plugin.repo || 'unknown/repo'
  const safeVersion = plugin.version || 'n/a'
  const installMode = plugin.installMode || 'native'
  const isClawhubSkill = installMode === 'clawhub'
  const isGatewaySkill = installMode === 'gateway'
  const installCommand = plugin.installCommand
    || (isClawhubSkill
      ? `clawhub install ${plugin.installName}`
      : plugin.isSkillMd
        ? `~/.openclaw/skills/${plugin.installName}/SKILL.md`
        : `openclaw plugin install ${plugin.installName}@${safeMarketplaceSlug}`)

  // A gateway skill has no repo or semver — "unknown/repo · by … · vn/a" was
  // three pieces of non-information. Say where it actually came from instead.
  const metaLine = isGatewaySkill
    ? [plugin.gatewaySource || safeAuthor, 'on your gateway', plugin.gatewayBlockReason]
      .filter(Boolean).join(' · ')
    : `${safeRepo} · by ${safeAuthor} · v${safeVersion}`

  // Gateway skills have no source repo, so the GitHub link would resolve to
  // `github.com//tree/main/` — a 404 dressed up as an action.
  const githubButton = !plugin.repo ? null : (
    <button
      onClick={handleGithubClick}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: colors.textTertiary,
        padding: 2,
        display: 'flex',
        borderRadius: 4,
      }}
      title="View source on GitHub"
      onMouseEnter={(e) => (e.currentTarget.style.color = colors.textPrimary)}
      onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
    >
      <GithubLogo size={14} />
    </button>
  )

  return (
    <motion.div
      ref={cardRef}
      layout
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
      onLayoutAnimationComplete={handleLayoutComplete}
      onClick={toggleExpand}
      style={{
        padding: '12px',
        borderRadius: 14,
        border: `1px solid ${expanded ? colors.surfaceSecondary : colors.containerBorder}`,
        background: expanded ? colors.surfaceActive : colors.surfaceHover,
        minHeight: expanded ? undefined : 154,
        width: expanded ? '100%' : 'calc(50% - 5px)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!expanded) {
          e.currentTarget.style.background = colors.surfaceActive
          e.currentTarget.style.borderColor = colors.surfaceSecondary
        }
      }}
      onMouseLeave={(e) => {
        if (!expanded) {
          e.currentTarget.style.background = colors.surfaceHover
          e.currentTarget.style.borderColor = colors.containerBorder
        }
      }}
    >
      {expanded ? (
        /* ── Expanded: full-width single column ── */
        <div>
          {/* Header row: tags + actions */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag label={safeCategory} colors={colors} emphasis="accent" />
              {(plugin.tags || []).map((tag) => (
                <Tag key={tag} label={tag} colors={colors} />
              ))}
            </div>
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {githubButton}
              <StatusButton status={status} colors={colors} onClick={handleInstallClick} onUninstall={(e) => { e.stopPropagation(); void uninstallPlugin(plugin) }} installMode={installMode} gatewayReady={plugin.gatewayReady} />
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
            {safeName}
          </div>
          <div style={{
            fontSize: 11,
            color: colors.textSecondary,
            marginTop: 5,
            lineHeight: 1.5,
          }}>
            {safeDescription}
          </div>
          <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 8 }}>
            {metaLine}
          </div>

          {/* Confirm panel or installing status */}
          {showConfirm && status === 'not_installed' && !isClawhubSkill && (
            <div style={{
              padding: '10px 12px', borderRadius: 10, marginTop: 10,
              background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`,
            }}>
              <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 4 }}>
                {plugin.isSkillMd ? 'Will install to:' : 'Will run:'}
              </div>
              <div style={{
                fontSize: 10, fontFamily: 'monospace', color: colors.textSecondary,
                background: colors.codeBg, padding: '4px 6px', borderRadius: 4,
                lineHeight: 1.6,
              }}>
                {installCommand}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  onClick={handleConfirm}
                  style={{
                    fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
                    background: colors.accent, color: colors.textOnAccent, border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Confirm Install
                </button>
                <button
                  onClick={handleCancel}
                  style={{
                    fontSize: 10, fontWeight: 500, padding: '4px 10px', borderRadius: 6,
                    background: 'transparent', color: colors.textSecondary,
                    border: `1px solid ${colors.containerBorder}`,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {isGatewaySkill && (
            <div style={{
              padding: '10px 12px', borderRadius: 10, marginTop: 10,
              background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`,
            }}>
              <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 4 }}>
                {plugin.gatewayReady === false
                  ? `On your gateway but not ready — ${plugin.gatewayBlockReason ?? 'requirements unmet'}. Inspect it with:`
                  : 'Already available on your gateway. Inspect it with:'}
              </div>
              <div style={{
                fontSize: 10, fontFamily: 'monospace', color: colors.textSecondary,
                background: colors.codeBg, padding: '4px 6px', borderRadius: 4,
                lineHeight: 1.6,
              }}>
                {installCommand}
              </div>
              {plugin.externalUrl && (
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.clui.openExternal(plugin.externalUrl!)
                    }}
                    style={{
                      fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
                      background: colors.accent, color: colors.textOnAccent, border: 'none',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Documentation
                  </button>
                </div>
              )}
            </div>
          )}

          {isClawhubSkill && (
            <div style={{
              padding: '10px 12px', borderRadius: 10, marginTop: 10,
              background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`,
            }}>
              <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 4 }}>
                Install from ClawHub:
              </div>
              <div style={{
                fontSize: 10, fontFamily: 'monospace', color: colors.textSecondary,
                background: colors.codeBg, padding: '4px 6px', borderRadius: 4,
                lineHeight: 1.6,
              }}>
                {installCommand}
              </div>
              {plugin.externalUrl && (
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.clui.openExternal(plugin.externalUrl!)
                    }}
                    style={{
                      fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
                      background: colors.accent, color: colors.textOnAccent, border: 'none',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Open Skill Page
                  </button>
                </div>
              )}
            </div>
          )}

          {status === 'installing' && (
            <div style={{
              padding: '10px 12px', borderRadius: 10, marginTop: 10,
              background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                style={{ display: 'flex' }}
              >
                <SpinnerGap size={14} style={{ color: colors.accent }} />
              </motion.div>
              <span style={{ fontSize: 11, color: colors.textSecondary }}>Installing plugin...</span>
            </div>
          )}
        </div>
      ) : (
        /* ── Collapsed: original layout ── */
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <Tag label={safeCategory} colors={colors} emphasis="accent" />
              {(plugin.tags || []).slice(0, 2).map((tag) => (
                <Tag key={tag} label={tag} colors={colors} />
              ))}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
              {safeName}
            </div>
            <div style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginTop: 5,
              lineHeight: 1.45,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {safeDescription}
            </div>
            <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 8 }}>
              {metaLine}
            </div>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            {githubButton}
            <StatusButton status={status} colors={colors} onClick={handleInstallClick} onUninstall={(e) => { e.stopPropagation(); void uninstallPlugin(plugin) }} installMode={installMode} gatewayReady={plugin.gatewayReady} />
          </div>
        </div>
      )}
    </motion.div>
  )
})

// ─── StatusButton ───

function StatusButton({ status, colors, onClick, onUninstall, installMode, gatewayReady }: {
  status: PluginStatus
  colors: ReturnType<typeof useColors>
  onClick: (e: React.MouseEvent) => void
  onUninstall?: (e: React.MouseEvent) => void
  installMode?: CatalogPlugin['installMode']
  gatewayReady?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const isClawhubSkill = installMode === 'clawhub'

  // Gateway skills are managed by the runtime, not from here. A hover-to-
  // Uninstall affordance would promise a local `rm -rf` of a directory that,
  // under a remote gateway, is not even on this machine.
  if (installMode === 'gateway') {
    // Muted, not red: a skill waiting on a binary it has never had is inactive,
    // not broken, and colouring it like a failure would misreport 28 of them.
    const blocked = gatewayReady === false
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
        background: blocked ? colors.surfacePrimary : colors.statusCompleteBg,
        color: blocked ? colors.textTertiary : colors.statusComplete,
        border: blocked ? `1px solid ${colors.containerBorder}` : 'none',
        whiteSpace: 'nowrap',
      }}>
        {blocked ? 'Not ready' : 'On gateway'}
      </span>
    )
  }

  if (isClawhubSkill) {
    if (status === 'installing') {
      return (
        <span style={{
          fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
          background: colors.accentLight, color: colors.accent,
          display: 'flex', alignItems: 'center', gap: 4,
          whiteSpace: 'nowrap',
        }}>
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            style={{ display: 'flex' }}
          >
            <SpinnerGap size={10} />
          </motion.div>
          Installing...
        </span>
      )
    }
    if (status === 'installed') {
      return (
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
          background: colors.statusCompleteBg, color: colors.statusComplete,
          border: 'none',
          whiteSpace: 'nowrap',
        }}>
          Installed
        </span>
      )
    }
    if (status === 'failed') {
      return (
        <button
          onClick={onClick}
          style={{
            fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
            background: colors.statusErrorBg, color: colors.statusError,
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          Failed - Retry
        </button>
      )
    }
    return (
      <button
        onClick={onClick}
        style={{
          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
          background: colors.accentLight, color: colors.accent,
          border: `1px solid ${colors.accentBorder}`,
          cursor: 'pointer', fontFamily: 'inherit',
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        Install
      </button>
    )
  }

  switch (status) {
    case 'installed':
      return (
        <button
          onClick={onUninstall}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
            background: hovered ? colors.statusErrorBg : colors.statusCompleteBg,
            color: hovered ? colors.statusError : colors.statusComplete,
            whiteSpace: 'nowrap',
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          {hovered ? 'Uninstall' : 'Installed'}
        </button>
      )
    case 'installing':
      return (
        <span style={{
          fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
          background: colors.accentLight, color: colors.accent,
          display: 'flex', alignItems: 'center', gap: 4,
          whiteSpace: 'nowrap',
        }}>
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            style={{ display: 'flex' }}
          >
            <SpinnerGap size={10} />
          </motion.div>
          Installing...
        </span>
      )
    case 'failed':
      return (
        <button
          onClick={onClick}
          style={{
            fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
            background: colors.statusErrorBg, color: colors.statusError,
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          Failed — Retry
        </button>
      )
    default:
      return (
        <button
          onClick={onClick}
          style={{
            fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
            background: colors.accentLight, color: colors.accent,
            border: `1px solid ${colors.accentBorder}`,
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = colors.accentSoft)}
          onMouseLeave={(e) => (e.currentTarget.style.background = colors.accentLight)}
        >
          Install
        </button>
      )
  }
}

function Tag({ label, colors, emphasis }: {
  label: string
  colors: ReturnType<typeof useColors>
  emphasis?: 'accent'
}) {
  const isAccent = emphasis === 'accent'
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        padding: '5px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        border: `1px solid ${isAccent ? colors.accentBorderMedium : colors.containerBorder}`,
        background: isAccent ? colors.accentLight : colors.surfacePrimary,
        color: isAccent ? colors.accent : colors.textSecondary,
      }}
    >
      {label}
    </span>
  )
}

// ─── States ───

function LoadingState({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ padding: '8px 10px' }}>
          <motion.div
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.15 }}
            style={{
              height: 12, width: '60%', borderRadius: 4,
              background: colors.surfacePrimary, marginBottom: 4,
            }}
          />
          <motion.div
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.15 + 0.1 }}
            style={{
              height: 10, width: '90%', borderRadius: 4,
              background: colors.surfacePrimary,
            }}
          />
        </div>
      ))}
    </div>
  )
}

function ErrorState({ error, colors, onRetry }: {
  error: string
  colors: ReturnType<typeof useColors>
  onRetry: () => void
}) {
  return (
    <div style={{ padding: '20px 10px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: colors.statusError, marginBottom: 8 }}>
        {error.length > 100 ? error.substring(0, 100) + '...' : error}
      </div>
      <button
        onClick={onRetry}
        style={{
          fontSize: 10, fontWeight: 600, padding: '4px 12px', borderRadius: 6,
          background: colors.accentLight, color: colors.accent,
          border: `1px solid ${colors.accentBorder}`,
          cursor: 'pointer', fontFamily: 'inherit',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        <ArrowClockwise size={11} /> Retry
      </button>
    </div>
  )
}

function EmptyState({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <div style={{
      padding: '24px 10px', textAlign: 'center',
      fontSize: 11, color: colors.textTertiary,
    }}>
      No plugins match your search
    </div>
  )
}
