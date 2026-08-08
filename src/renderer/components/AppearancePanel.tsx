import React, { useState } from 'react'
import {
  Palette, ArrowsClockwise, DownloadSimple, UploadSimple, Trash, Check,
} from '@phosphor-icons/react'
import { useColors, useThemeStore, BUILT_IN_THEMES } from '../theme'
import { derivePalette } from '../theme-derive'
import type { Theme, ThemeSeeds } from '../../shared/theme-types'

type Colors = ReturnType<typeof useColors>

/** The ten authored seeds, in the order they make sense to edit. */
const SEED_FIELDS: Array<{ key: keyof ThemeSeeds; label: string; hint: string }> = [
  { key: 'accent', label: 'Accent', hint: 'Buttons, active states, running status' },
  { key: 'accentAlt', label: 'Accent alt', hint: 'Glows, timeline nodes, highlights' },
  { key: 'bg', label: 'Background', hint: 'Deepest container surface' },
  { key: 'surface', label: 'Surface', hint: 'Cards, tabs, tool blocks' },
  { key: 'border', label: 'Border', hint: 'Hairlines' },
  { key: 'text', label: 'Text', hint: 'Primary text' },
  { key: 'textDim', label: 'Text dim', hint: 'Secondary text' },
  { key: 'success', label: 'Success', hint: 'Completed status' },
  { key: 'warning', label: 'Warning', hint: 'Permission prompts' },
  { key: 'danger', label: 'Danger', hint: 'Errors, stop button' },
]

const BRAND_FIELDS: Array<{ key: keyof Theme['branding']; label: string; placeholder: string }> = [
  { key: 'appName', label: 'App name', placeholder: 'OpenClaw' },
  { key: 'assistantName', label: 'Assistant name', placeholder: 'Shown in transcripts' },
  { key: 'glyph', label: 'Glyph', placeholder: 'Emoji or 1-2 chars' },
  { key: 'tagline', label: 'Tagline', placeholder: 'Shown in the tray tooltip' },
  { key: 'greeting', label: 'Greeting', placeholder: 'Empty-state line' },
  { key: 'inputPlaceholder', label: 'Input placeholder', placeholder: 'Ask ... anything' },
]

export function AppearancePanel() {
  const colors = useColors()
  const theme = useThemeStore((s) => s.theme)
  const customThemes = useThemeStore((s) => s.customThemes)
  const isDark = useThemeStore((s) => s.isDark)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const selectTheme = useThemeStore((s) => s.selectTheme)
  const updateActiveTheme = useThemeStore((s) => s.updateActiveTheme)
  const upsertCustomTheme = useThemeStore((s) => s.upsertCustomTheme)
  const deleteCustomTheme = useThemeStore((s) => s.deleteCustomTheme)
  const resetTheme = useThemeStore((s) => s.resetTheme)

  const [status, setStatus] = useState<string | null>(null)

  // Edits apply to whichever mode is on screen, so what you change is what you see.
  const mode: 'dark' | 'light' = isDark ? 'dark' : 'light'
  const seeds = theme[mode]

  const setSeed = (key: keyof ThemeSeeds, value: string): void => {
    updateActiveTheme({ [mode]: { [key]: value } } as any)
  }

  const exportTheme = async (): Promise<void> => {
    const res = await window.clui.exportTheme(theme, theme.name || theme.id)
    if (res.cancelled) return
    setStatus(res.ok ? `Exported to ${res.path}` : `Export failed: ${res.error}`)
  }

  const importTheme = async (): Promise<void> => {
    const res = await window.clui.importTheme()
    if (res.cancelled) return
    if (!res.ok || !res.theme) { setStatus(`Import failed: ${res.error}`); return }
    upsertCustomTheme(res.theme)
    setStatus(`Imported "${res.theme.name}"`)
  }

  const allThemes = [...BUILT_IN_THEMES, ...customThemes]

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Theme" colors={colors}>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 8 }}>
          Pick a preset, then edit it. Editing a built-in forks it into your own copy, so the
          originals are always there to go back to.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
          {allThemes.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              isDark={isDark}
              active={t.id === theme.id}
              colors={colors}
              onSelect={() => selectTheme(t.id)}
              onDelete={t.builtIn ? undefined : () => { deleteCustomTheme(t.id); setStatus(`Deleted "${t.name}"`) }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['dark', 'light', 'system'] as const).map((m) => (
            <Pill key={m} active={themeMode === m} label={m} onClick={() => setThemeMode(m)} colors={colors} />
          ))}
          <div style={{ flex: 1 }} />
          <SmallBtn onClick={() => { void importTheme() }} icon={<UploadSimple size={11} />} label="Import" colors={colors} />
          <SmallBtn onClick={() => { void exportTheme() }} icon={<DownloadSimple size={11} />} label="Export" colors={colors} />
          <SmallBtn onClick={() => { resetTheme(); setStatus('Reset to default') }} icon={<ArrowsClockwise size={11} />} label="Reset" colors={colors} />
        </div>

        {status && (
          <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 8, overflowWrap: 'anywhere' }}>{status}</div>
        )}
      </Card>

      <Card title={`Colours — ${mode} mode`} colors={colors}>
        <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 8, lineHeight: 1.45 }}>
          Ten seeds drive all {78} tokens. Text contrast is enforced automatically, so a hard-to-read
          combination gets corrected rather than shipped.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {SEED_FIELDS.map((f) => (
            <SeedRow
              key={f.key}
              label={f.label}
              hint={f.hint}
              value={seeds[f.key]}
              onChange={(v) => setSeed(f.key, v)}
              colors={colors}
            />
          ))}
        </div>
      </Card>

      <Card title="Shape & Feel" colors={colors}>
        <SliderRow
          label="Corner radius" suffix="px" min={0} max={32} step={1}
          value={theme.effects.radius}
          onChange={(v) => updateActiveTheme({ effects: { radius: v } })}
          colors={colors}
        />
        <SliderRow
          label="Glow" suffix="" min={0} max={1} step={0.05}
          value={theme.effects.glow}
          onChange={(v) => updateActiveTheme({ effects: { glow: v } })}
          colors={colors}
          hint="Above 0.6 adds an accent bloom to shadows"
        />
        <SliderRow
          label="Backdrop blur" suffix="px" min={0} max={40} step={1}
          value={theme.effects.blur}
          onChange={(v) => updateActiveTheme({ effects: { blur: v } })}
          colors={colors}
        />
      </Card>

      <Card title="Branding" colors={colors}>
        <div style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 8, lineHeight: 1.45 }}>
          Renames what you see — window title, tray, transcripts, placeholders. It never touches the
          CLI, its arguments, or <code>~/.openclaw</code>.
        </div>
        <div style={{ display: 'grid', gap: 7 }}>
          {BRAND_FIELDS.map((f) => (
            <TextRow
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              value={theme.branding[f.key] || ''}
              onChange={(v) => updateActiveTheme({ branding: { [f.key]: v } as any })}
              colors={colors}
            />
          ))}
        </div>
      </Card>
    </div>
  )
}

/* ─── Pieces ─── */

function ThemeCard({ theme, isDark, active, colors, onSelect, onDelete }: {
  theme: Theme
  isDark: boolean
  active: boolean
  colors: Colors
  onSelect: () => void
  onDelete?: () => void
}) {
  // Preview with the theme's own colours, not the active ones.
  const p = (() => {
    try {
      const seeds = isDark ? theme.dark : theme.light
      const ov = isDark ? theme.overrides?.dark : theme.overrides?.light
      return derivePalette(seeds, theme.effects, isDark, ov as any)
    } catch {
      return null
    }
  })()

  return (
    <div
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        borderRadius: 10,
        border: `1px solid ${active ? colors.accent : colors.containerBorder}`,
        background: p?.containerBg || colors.surfacePrimary,
        padding: 9,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
        <span style={{ fontSize: 12 }}>{theme.branding.glyph}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, flex: 1, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: p?.textPrimary || colors.textPrimary,
        }}>
          {theme.name}
        </span>
        {active && <Check size={11} style={{ color: colors.accent, flexShrink: 0 }} />}
      </div>

      {/* Swatch strip — a real preview of the derived palette */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
        {[p?.accent, p?.timelineNodeActive, p?.surfacePrimary, p?.statusComplete, p?.statusError].map((c, i) => (
          <span key={i} style={{ flex: 1, height: 14, borderRadius: 3, background: c || 'transparent' }} />
        ))}
      </div>

      <div style={{
        fontSize: 9, color: p?.textTertiary || colors.textTertiary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {theme.branding.tagline}
      </div>

      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="Delete this theme"
          style={{
            position: 'absolute', top: 6, right: 6, background: 'none', border: 'none',
            color: colors.textTertiary, cursor: 'pointer', padding: 2, lineHeight: 0,
          }}
        >
          <Trash size={11} />
        </button>
      )}
    </div>
  )
}

function SeedRow({ label, hint, value, onChange, colors }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; colors: Colors
}) {
  // A colour input needs #rrggbb; the text field accepts anything the
  // derivation can parse (rgb(), shorthand hex, a few names).
  const asHex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <div style={{ fontSize: 10, color: colors.textSecondary }} title={hint}>{label}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          type="color"
          value={asHex}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 26, height: 24, padding: 0, border: `1px solid ${colors.containerBorder}`,
            borderRadius: 6, background: 'transparent', cursor: 'pointer', flexShrink: 0,
          }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, fontSize: 10, fontFamily: 'ui-monospace, monospace',
            borderRadius: 6, background: colors.surfaceHover, color: colors.textPrimary,
            border: `1px solid ${colors.containerBorder}`, padding: '5px 6px',
          }}
        />
      </div>
    </div>
  )
}

function SliderRow({ label, suffix, min, max, step, value, onChange, colors, hint }: {
  label: string; suffix: string; min: number; max: number; step: number
  value: number; onChange: (v: number) => void; colors: Colors; hint?: string
}) {
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: colors.textSecondary }}>
        <span>{label}</span>
        <span style={{ color: colors.textTertiary, fontFamily: 'ui-monospace, monospace' }}>
          {step < 1 ? value.toFixed(2) : value}{suffix}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: colors.accent, marginTop: 3 }}
      />
      {hint && <div style={{ fontSize: 9, color: colors.textTertiary }}>{hint}</div>}
    </div>
  )
}

function TextRow({ label, placeholder, value, onChange, colors }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; colors: Colors
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center' }}>
      <div style={{ fontSize: 10, color: colors.textSecondary }}>{label}</div>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontSize: 11, borderRadius: 7, background: colors.surfaceHover, color: colors.textPrimary,
          border: `1px solid ${colors.containerBorder}`, padding: '6px 8px', minWidth: 0,
        }}
      />
    </div>
  )
}

function Pill({ active, label, onClick, colors }: {
  active: boolean; label: string; onClick: () => void; colors: Colors
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 10, fontWeight: 600, borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
        fontFamily: 'inherit', textTransform: 'capitalize',
        border: `1px solid ${active ? colors.accent : colors.containerBorder}`,
        background: active ? colors.accentLight : colors.surfacePrimary,
        color: active ? colors.accent : colors.textSecondary,
      }}
    >
      {label}
    </button>
  )
}

function SmallBtn({ onClick, icon, label, colors }: {
  onClick: () => void; icon: React.ReactNode; label: string; colors: Colors
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 10, fontWeight: 600, border: `1px solid ${colors.containerBorder}`,
        background: colors.surfacePrimary, color: colors.textSecondary, borderRadius: 7,
        padding: '5px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
        gap: 5, fontFamily: 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function Card({ title, children, colors }: { title: string; children: React.ReactNode; colors: Colors }) {
  return (
    <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 12, background: colors.surfaceHover, padding: 11 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: colors.textPrimary, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Palette size={13} />
        {title}
      </div>
      {children}
    </div>
  )
}
