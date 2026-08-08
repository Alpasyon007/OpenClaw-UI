import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, MagnifyingGlass, Check } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'

/**
 * A dropdown that works inside the transparent click-through overlay.
 *
 * A native <select> cannot be used here: its popup is an OS-level window, not
 * a DOM node, so App.tsx's click-through detector — which tests
 * document.elementFromPoint(...).closest('[data-clui-ui]') — sees nothing
 * under the cursor and tells Electron to ignore mouse events. The popup then
 * stops receiving wheel and click events and cannot be scrolled.
 *
 * Rendering the list into the popover layer as real DOM keeps it visible to
 * that detector, and gives us scrolling, filtering and keyboard control.
 */

export interface SelectOption {
  value: string
  label: string
  /** Optional dimmer secondary text shown to the right. */
  hint?: string
}

const MAX_LIST_HEIGHT = 240
const FILTER_THRESHOLD = 8

export function ScrollableSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select...',
  ariaLabel,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
}) {
  const colors = useColors()
  const layer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [rect, setRect] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)
  // Only keyboard navigation should scroll the list. Wheel-scrolling moves
  // rows under a stationary cursor, which re-fires mouseenter and would
  // otherwise scroll the row back into view, fighting the wheel.
  const navSourceRef = useRef<'key' | 'mouse'>('key')

  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLDivElement | null>>([])

  const selected = options.find((o) => o.value === value) || null
  const showFilter = options.length > FILTER_THRESHOLD

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [options, query])

  // Position the list against the trigger, flipping above when there is not
  // enough room below — the overlay sits at the bottom of the screen.
  const reposition = (): void => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const needed = Math.min(MAX_LIST_HEIGHT + (showFilter ? 42 : 0) + 12, MAX_LIST_HEIGHT + 54)
    const below = spaceBelow >= needed
    // Keep the list within the window horizontally.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8))

    setRect(
      below
        // Anchoring the flipped case by its BOTTOM edge keeps it attached to
        // the trigger. Computing a top from the theoretical maximum height
        // would leave a short list floating far above it.
        ? { top: r.bottom + 4, left, width: r.width }
        : { bottom: window.innerHeight - r.top + 4, left, width: r.width },
    )
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onScrollOrResize = () => reposition()
    window.addEventListener('resize', onScrollOrResize)
    // Capture phase catches scrolling in any ancestor container.
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open, showFilter, options.length])

  useEffect(() => {
    if (!open) return
    // Opening should reveal the current selection, so treat it as keyboard nav.
    navSourceRef.current = 'key'
    const idx = filtered.findIndex((o) => o.value === value)
    setActiveIndex(idx >= 0 ? idx : 0)
  }, [open])

  // Keep the highlighted row inside the scroll viewport — but only when the
  // keyboard moved it. Doing this on mouse hover fights wheel scrolling.
  useEffect(() => {
    if (!open || navSourceRef.current !== 'key') return
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // Close on outside interaction. Pointerdown fires before focus moves.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const commit = (v: string): void => {
    onChange(v)
    setOpen(false)
    setQuery('')
    triggerRef.current?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQuery(''); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); navSourceRef.current = 'key'; setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); navSourceRef.current = 'key'; setActiveIndex((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Home') { e.preventDefault(); navSourceRef.current = 'key'; setActiveIndex(0); return }
    if (e.key === 'End') { e.preventDefault(); navSourceRef.current = 'key'; setActiveIndex(filtered.length - 1); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) commit(opt.value)
    }
  }

  const triggerStyle: React.CSSProperties = {
    width: '100%',
    fontSize: 12,
    borderRadius: 8,
    background: colors.surfacePrimary,
    color: selected ? colors.textPrimary : colors.textTertiary,
    border: `1px solid ${open ? colors.accent : colors.containerBorder}`,
    padding: '8px 9px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    fontFamily: 'inherit',
    textAlign: 'left',
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((v) => !v) }}
        onKeyDown={onKeyDown}
        style={triggerStyle}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <CaretDown size={11} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>

      {open && rect && layer && createPortal(
        <div
          ref={listRef}
          data-clui-ui
          role="listbox"
          onKeyDown={onKeyDown}
          style={{
            position: 'fixed',
            ...(rect.top != null ? { top: rect.top } : {}),
            ...(rect.bottom != null ? { bottom: rect.bottom } : {}),
            left: rect.left,
            width: rect.width,
            // The layer is pointer-events:none so transparent regions stay
            // click-through; the popup itself must opt back in.
            pointerEvents: 'auto',
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 10000,
          }}
        >
          {showFilter && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderBottom: `1px solid ${colors.containerBorder}` }}>
              <MagnifyingGlass size={11} color={colors.textTertiary} />
              <input
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
                onKeyDown={onKeyDown}
                placeholder="Filter..."
                style={{
                  flex: 1,
                  fontSize: 11,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: colors.textPrimary,
                  fontFamily: 'inherit',
                }}
              />
            </div>
          )}

          <div style={{ maxHeight: MAX_LIST_HEIGHT, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '10px 11px', fontSize: 11, color: colors.textTertiary }}>No matches</div>
            )}
            {filtered.map((opt, i) => {
              const isSelected = opt.value === value
              const isActive = i === activeIndex
              return (
                <div
                  key={opt.value}
                  ref={(el) => { itemRefs.current[i] = el }}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => { navSourceRef.current = 'mouse'; setActiveIndex(i) }}
                  onClick={() => commit(opt.value)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                    background: isActive ? colors.surfaceHover : 'transparent',
                    color: isSelected ? colors.accent : colors.textSecondary,
                  }}
                >
                  <span style={{ width: 12, flexShrink: 0 }}>
                    {isSelected && <Check size={11} />}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {opt.label}
                  </span>
                  {opt.hint && (
                    <span style={{ fontSize: 10, color: colors.textTertiary, flexShrink: 0 }}>{opt.hint}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>,
        layer,
      )}
    </>
  )
}
