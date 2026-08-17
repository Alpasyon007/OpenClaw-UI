/**
 * The theme editor.
 *
 * A theme is authored from ten seeds per mode; the ~68 runtime tokens are
 * derived. That is the whole reason this is usable on a phone — editing 68
 * colours in a text field is not a thing anyone would finish, and editing ten
 * is an afternoon at most.
 *
 * Edits are held locally and written on Save rather than live. Live-saving a
 * theme that is also the *active* theme repaints the entire app — including
 * this editor — on every keystroke, which makes a half-typed hex value briefly
 * turn the screen unreadable and the text field invisible. The preview strip
 * shows the result instead, derived from the working copy without selecting it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import type { ColorPalette, Theme, ThemeSeeds } from '@openclaw/theme'
import {
  paletteFor,
  useAvailableThemes,
  useColors,
  useIsDark,
  useThemeStore,
  font,
  radius,
  space,
} from '../lib/theme'
import { expandHex, isHex, isLight, normaliseHexInput } from '../lib/color'
import { Banner, Button, EmptyState, Section, Segmented } from '../components/ui'

/** The ten seeds, in the order they make sense to work through. */
const SEED_FIELDS: ReadonlyArray<{ key: keyof ThemeSeeds; label: string; hint: string }> = [
  { key: 'accent', label: 'Accent', hint: 'Buttons, active states, running status' },
  { key: 'accentAlt', label: 'Accent alt', hint: 'Glows, timeline nodes, highlights' },
  { key: 'bg', label: 'Background', hint: 'Deepest container background' },
  { key: 'surface', label: 'Surface', hint: 'Cards, tabs, tool blocks' },
  { key: 'border', label: 'Border', hint: 'Hairlines' },
  { key: 'text', label: 'Text', hint: 'Primary text' },
  { key: 'textDim', label: 'Text dim', hint: 'Secondary and tertiary text derive from this' },
  { key: 'success', label: 'Success', hint: 'Completed status' },
  { key: 'warning', label: 'Warning', hint: 'Permission and caution status' },
  { key: 'danger', label: 'Danger', hint: 'Errors and destructive actions' },
]

export default function ThemeEditorScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const systemDark = useIsDark()

  const themes = useAvailableThemes()
  const saveTheme = useThemeStore((s) => s.saveTheme)
  const setThemeId = useThemeStore((s) => s.setThemeId)
  const activeId = useThemeStore((s) => s.themeId)

  const original = themes.find((t) => t.id === params.id)

  // The working copy is seeded once. Re-seeding it from `themes` on every
  // render would discard the user's edits the moment anything else in the store
  // changed.
  const [draft, setDraft] = useState<Theme | null>(original ?? null)

  // Adopt the theme if it only appears after this screen mounted — navigating
  // here before the theme store has finished hydrating is a real ordering, and
  // without this it renders "Theme not found" permanently. Guarded on `draft`
  // being null so it can never clobber an edit in progress.
  useEffect(() => {
    if (!draft && original) setDraft(original)
  }, [draft, original])
  const [editingMode, setEditingMode] = useState<'dark' | 'light'>(systemDark ? 'dark' : 'light')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  const preview = useMemo(
    () => (draft ? paletteFor(draft, editingMode === 'dark') : null),
    [draft, editingMode],
  )

  const setSeed = useCallback(
    (key: keyof ThemeSeeds, value: string) => {
      setDraft((current) =>
        current
          ? { ...current, [editingMode]: { ...current[editingMode], [key]: value } }
          : current,
      )
    },
    [editingMode],
  )

  const setEffect = useCallback((key: 'radius' | 'glow' | 'blur', value: number) => {
    setDraft((current) =>
      current ? { ...current, effects: { ...current.effects, [key]: value } } : current,
    )
  }, [])

  const onSave = useCallback(async () => {
    if (!draft) return

    // Partial hex values are a normal state while typing, but they are not a
    // theme. Naming the first offender beats a generic "invalid colour" that
    // leaves the user hunting through twenty fields.
    for (const mode of ['dark', 'light'] as const) {
      for (const field of SEED_FIELDS) {
        const value = draft[mode][field.key]
        if (!isHex(value)) {
          setNotice(`${field.label} (${mode}) is not a complete colour: “${value}”`)
          setEditingMode(mode)
          return
        }
      }
    }

    setSaving(true)
    const normalised: Theme = {
      ...draft,
      name: draft.name.trim() || 'Untitled theme',
      dark: normaliseSeeds(draft.dark),
      light: normaliseSeeds(draft.light),
    }
    const ok = await saveTheme(normalised)
    setSaving(false)

    if (!ok) {
      setNotice('Could not save. Storage may be full.')
      return
    }
    setDraft(normalised)
    setNotice('Saved.')
    // Applying on save is the expected outcome of finishing an edit, but only
    // for a theme that was already selected or has just been made — silently
    // switching the app's theme because someone opened an editor would be a
    // surprise.
    if (activeId === normalised.id) setThemeId(normalised.id)
  }, [draft, saveTheme, setThemeId, activeId])

  if (!draft || !preview) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Stack.Screen options={{ title: 'Theme' }} />
        <EmptyState
          title="Theme not found"
          detail="It may have been deleted. Go back and pick another."
        />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: draft.name || 'Theme' }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {notice ? <Banner message={notice} /> : null}

        <Preview palette={preview} name={draft.name} styles={styles} />

        <Section title="Name">
          <TextInput
            style={styles.input}
            value={draft.name}
            onChangeText={(name) => setDraft((c) => (c ? { ...c, name } : c))}
            placeholder="Theme name"
            placeholderTextColor={colors.textTertiary}
          />
        </Section>

        <Section
          title="Editing"
          hint="Each mode has its own ten seeds. Both are saved; the app uses whichever the current mode resolves to."
        >
          <Segmented
            options={['dark', 'light'] as const}
            value={editingMode}
            onChange={setEditingMode}
          />
        </Section>

        <Section title="Seeds">
          {SEED_FIELDS.map((field) => (
            <SeedField
              key={field.key}
              label={field.label}
              hint={field.hint}
              value={draft[editingMode][field.key]}
              onChange={(value) => setSeed(field.key, value)}
              styles={styles}
              colors={colors}
            />
          ))}
        </Section>

        <Section title="Effects" hint="Radius scales every corner; glow drives accent shadows.">
          <NumberField
            label="Radius"
            value={draft.effects.radius}
            min={0}
            max={32}
            onChange={(v) => setEffect('radius', v)}
            styles={styles}
            colors={colors}
          />
          <NumberField
            label="Glow"
            value={draft.effects.glow}
            min={0}
            max={1}
            step={0.1}
            onChange={(v) => setEffect('glow', v)}
            styles={styles}
            colors={colors}
          />
          <NumberField
            label="Blur"
            value={draft.effects.blur}
            min={0}
            max={40}
            onChange={(v) => setEffect('blur', v)}
            styles={styles}
            colors={colors}
          />
        </Section>

        <Section
          title="Branding"
          hint="Presentation only. Never used for file paths, channels or CLI arguments."
        >
          <BrandField
            label="App name"
            value={draft.branding.appName}
            onChange={(appName) =>
              setDraft((c) => (c ? { ...c, branding: { ...c.branding, appName } } : c))
            }
            styles={styles}
            colors={colors}
          />
          <BrandField
            label="Assistant name"
            value={draft.branding.assistantName}
            onChange={(assistantName) =>
              setDraft((c) => (c ? { ...c, branding: { ...c.branding, assistantName } } : c))
            }
            styles={styles}
            colors={colors}
          />
          <BrandField
            label="Greeting"
            value={draft.branding.greeting}
            onChange={(greeting) =>
              setDraft((c) => (c ? { ...c, branding: { ...c.branding, greeting } } : c))
            }
            styles={styles}
            colors={colors}
          />
          <BrandField
            label="Input placeholder"
            value={draft.branding.inputPlaceholder}
            onChange={(inputPlaceholder) =>
              setDraft((c) => (c ? { ...c, branding: { ...c.branding, inputPlaceholder } } : c))
            }
            styles={styles}
            colors={colors}
          />
        </Section>

        <View style={styles.footer}>
          <Button label="Save" variant="primary" busy={saving} onPress={() => void onSave()} style={styles.grow} />
          <Button
            label="Use it"
            onPress={() => {
              setThemeId(draft.id)
              router.back()
            }}
            style={styles.grow}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

/**
 * A strip showing what the seeds derive into.
 *
 * Real derived tokens rather than the seeds themselves — the point of a
 * seed-based theme is that most of what you see is computed, and a preview of
 * the inputs would not show whether the outputs are legible.
 */
function Preview({
  palette,
  name,
  styles,
}: {
  palette: ColorPalette
  name: string
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={[styles.preview, { backgroundColor: palette.containerBg }]}>
      <View style={[styles.previewBubble, { backgroundColor: palette.surfacePrimary, borderColor: palette.containerBorder }]}>
        <Text style={{ color: palette.textPrimary, fontSize: font.size.sm }}>{name || 'Untitled'}</Text>
        <Text style={{ color: palette.textSecondary, fontSize: font.size.xs }}>
          Secondary text on a surface
        </Text>
      </View>
      <View style={styles.previewRow}>
        <View style={[styles.previewPill, { backgroundColor: palette.accent }]}>
          <Text style={{ color: palette.textOnAccent, fontSize: font.size.xs, fontWeight: '700' }}>
            Accent
          </Text>
        </View>
        <View style={[styles.previewDot, { backgroundColor: palette.statusComplete }]} />
        <View style={[styles.previewDot, { backgroundColor: palette.statusRunning }]} />
        <View style={[styles.previewDot, { backgroundColor: palette.statusPermission }]} />
        <View style={[styles.previewDot, { backgroundColor: palette.statusError }]} />
      </View>
    </View>
  )
}

function SeedField({
  label,
  hint,
  value,
  onChange,
  styles,
  colors,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  styles: ReturnType<typeof makeStyles>
  colors: ColorPalette
}) {
  const valid = isHex(value)
  return (
    <View style={styles.seedRow}>
      {/* The swatch keeps the last valid colour while a partial value is being
          typed, so the row does not blink to transparent between keystrokes. */}
      <View
        style={[
          styles.seedSwatch,
          { backgroundColor: valid ? expandHex(value) : colors.surfaceSecondary },
        ]}
      >
        {valid ? null : <Text style={styles.seedSwatchMark}>?</Text>}
      </View>
      <View style={styles.grow}>
        <Text style={styles.seedLabel}>{label}</Text>
        <Text style={styles.seedHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <TextInput
        style={[styles.hexInput, !valid && styles.hexInputInvalid]}
        value={value}
        onChangeText={(next) => onChange(normaliseHexInput(next))}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={7}
        placeholder="#000000"
        placeholderTextColor={colors.textTertiary}
        selectTextOnFocus
      />
    </View>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  styles,
  colors,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  styles: ReturnType<typeof makeStyles>
  colors: ColorPalette
}) {
  // Stepper rather than a slider: there is no slider in the dependency set, and
  // these are values people set once to a specific number rather than sweep.
  const clamp = (next: number): number =>
    Math.round(Math.min(max, Math.max(min, next)) * 100) / 100

  return (
    <View style={styles.numberRow}>
      <Text style={styles.seedLabel}>{label}</Text>
      <View style={styles.grow} />
      <Button label="−" onPress={() => onChange(clamp(value - step))} style={styles.stepper} />
      <Text style={[styles.numberValue, { color: colors.textPrimary }]}>{value}</Text>
      <Button label="+" onPress={() => onChange(clamp(value + step))} style={styles.stepper} />
    </View>
  )
}

function BrandField({
  label,
  value,
  onChange,
  styles,
  colors,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  styles: ReturnType<typeof makeStyles>
  colors: ColorPalette
}) {
  return (
    <View style={styles.brandRow}>
      <Text style={styles.seedLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholderTextColor={colors.textTertiary}
      />
    </View>
  )
}

function normaliseSeeds(seeds: ThemeSeeds): ThemeSeeds {
  const out = {} as ThemeSeeds
  for (const field of SEED_FIELDS) out[field.key] = expandHex(seeds[field.key])
  return out
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg, paddingBottom: space.xl * 2 },
    grow: { flex: 1 },

    preview: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
      gap: space.sm,
      marginBottom: space.xl,
    },
    previewBubble: { borderRadius: radius.sm, borderWidth: 1, padding: space.sm, gap: 2 },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    previewPill: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
    previewDot: { width: 12, height: 12, borderRadius: radius.pill },

    input: {
      backgroundColor: colors.surfacePrimary,
      color: colors.textPrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      fontSize: font.size.sm,
    },

    seedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: space.xs,
    },
    seedSwatch: {
      width: 34,
      height: 34,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    seedSwatchMark: { color: colors.textTertiary, fontSize: font.size.sm },
    seedLabel: { color: colors.textPrimary, fontSize: font.size.sm },
    seedHint: { color: colors.textTertiary, fontSize: 10 },
    hexInput: {
      width: 96,
      backgroundColor: colors.surfacePrimary,
      color: colors.textPrimary,
      fontFamily: font.mono,
      fontSize: font.size.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingHorizontal: space.sm,
      paddingVertical: space.sm,
      textAlign: 'center',
    },
    hexInputInvalid: { borderColor: colors.statusPermission },

    numberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
    numberValue: { width: 48, textAlign: 'center', fontFamily: font.mono, fontSize: font.size.sm },
    stepper: { width: 44, paddingHorizontal: 0, paddingVertical: 6, minHeight: 34 },

    brandRow: { gap: space.xs, marginBottom: space.md },

    footer: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  })
