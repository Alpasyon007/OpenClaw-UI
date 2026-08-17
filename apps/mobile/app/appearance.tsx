/**
 * Appearance — pick a theme, or write one.
 *
 * The list is the whole screen; authoring happens in the editor behind it. That
 * split exists because selecting a theme is a one-tap action people do often
 * and editing one is a long session they do rarely, and putting both on one
 * screen makes the common case scroll past the rare one.
 *
 * Built-ins cannot be edited in place — "Duplicate" is offered instead. Letting
 * an edit shadow a shipped preset means an app update that changes the preset
 * silently does nothing, and there is no way back to the original.
 */
import { useCallback, useMemo, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { THEME_FILE_KIND, THEME_FILE_VERSION, validateTheme, type Theme } from '@openclaw/theme'
import type { ColorPalette } from '@openclaw/theme'
import {
  isBuiltIn,
  paletteFor,
  useAvailableThemes,
  useColors,
  useIsDark,
  useThemeStore,
  font,
  radius,
  space,
  type ThemeMode,
} from '../lib/theme'
import { themeIdFrom } from '../lib/color'
import { readClipboard, shareText } from '../lib/share'
import { Banner, Button, Section, Segmented } from '../components/ui'

export default function AppearanceScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const isDark = useIsDark()

  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const themeId = useThemeStore((s) => s.themeId)
  const setThemeId = useThemeStore((s) => s.setThemeId)
  const saveTheme = useThemeStore((s) => s.saveTheme)
  const deleteTheme = useThemeStore((s) => s.deleteTheme)
  const themes = useAvailableThemes()

  const [notice, setNotice] = useState('')

  const duplicate = useCallback(
    async (source: Theme) => {
      const copy: Theme = {
        ...source,
        // A fresh id and no `builtIn` flag: a duplicate of a preset is a
        // user theme, and carrying the flag over would make it uneditable too.
        id: themeIdFrom(source.name, String(Date.now()).slice(-6)),
        name: `${source.name} copy`,
        builtIn: false,
      }
      const ok = await saveTheme(copy)
      if (!ok) {
        setNotice('Could not save the theme. Storage may be full.')
        return
      }
      router.push({ pathname: '/theme-editor', params: { id: copy.id } })
    },
    [saveTheme, router],
  )

  const exportTheme = useCallback(async (theme: Theme) => {
    const outcome = await shareText(
      JSON.stringify({ kind: THEME_FILE_KIND, version: THEME_FILE_VERSION, theme }, null, 2),
      `${theme.id}.json`,
      'application/json',
    )
    if (!outcome.ok) setNotice(outcome.error)
    else if (outcome.via === 'clipboard') setNotice('Theme copied to the clipboard.')
  }, [])

  const importTheme = useCallback(async () => {
    const text = await readClipboard()
    if (!text.trim()) {
      setNotice('The clipboard is empty. Copy a theme JSON first.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setNotice('That is not JSON.')
      return
    }
    const result = validateTheme(parsed)
    if (!result.ok) {
      setNotice(`Not a usable theme: ${result.error}`)
      return
    }
    // Imported themes are re-identified. Keeping the incoming id would let an
    // import silently overwrite a theme the user already has under that id.
    const theme: Theme = {
      ...result.theme,
      id: themeIdFrom(result.theme.name, String(Date.now()).slice(-6)),
      builtIn: false,
    }
    const ok = await saveTheme(theme)
    setNotice(ok ? `Imported “${theme.name}”.` : 'Could not save the imported theme.')
  }, [saveTheme])

  const confirmDelete = useCallback(
    (theme: Theme) => {
      Alert.alert(`Delete “${theme.name}”?`, 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void deleteTheme(theme.id) },
      ])
    },
    [deleteTheme],
  )

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Appearance' }} />
      <ScrollView contentContainerStyle={styles.container}>
        {notice ? <Banner message={notice} /> : null}

        <Section
          title="Mode"
          hint="System follows the device. The palette derives from the same seeds the desktop uses, so both surfaces render identical colour."
        >
          <Segmented
            options={['system', 'light', 'dark'] as ThemeMode[]}
            value={mode}
            onChange={setMode}
          />
        </Section>

        <Section title={`Themes (${themes.length})`}>
          {themes.map((theme) => {
            // Previewed in the mode currently in effect, not the theme's own
            // default — a card showing dark swatches while the app is light
            // tells you nothing about what selecting it would do.
            const palette = paletteFor(theme, isDark)
            const active = theme.id === themeId
            const builtIn = isBuiltIn(theme.id)

            return (
              <View key={theme.id} style={[styles.card, active && styles.cardActive]}>
                <Pressable style={styles.cardMain} onPress={() => setThemeId(theme.id)}>
                  <View style={styles.swatches}>
                    <View style={[styles.swatch, { backgroundColor: palette.accent }]} />
                    <View style={[styles.swatch, { backgroundColor: palette.containerBg }]} />
                    <View style={[styles.swatch, { backgroundColor: palette.surfacePrimary }]} />
                    <View style={[styles.swatch, { backgroundColor: palette.textPrimary }]} />
                  </View>
                  <View style={styles.grow}>
                    <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                      {theme.name}
                    </Text>
                    <Text style={styles.meta}>
                      {builtIn ? 'Built in' : 'Custom'} · radius {theme.effects.radius} · glow{' '}
                      {theme.effects.glow}
                    </Text>
                  </View>
                  {active ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>

                <View style={styles.actions}>
                  {builtIn ? (
                    <Button
                      label="Duplicate"
                      onPress={() => void duplicate(theme)}
                      style={styles.action}
                    />
                  ) : (
                    <>
                      <Button
                        label="Edit"
                        onPress={() =>
                          router.push({ pathname: '/theme-editor', params: { id: theme.id } })
                        }
                        style={styles.action}
                      />
                      <Button
                        label="Delete"
                        variant="danger"
                        onPress={() => confirmDelete(theme)}
                        style={styles.action}
                      />
                    </>
                  )}
                  <Button
                    label="Export"
                    onPress={() => void exportTheme(theme)}
                    style={styles.action}
                  />
                </View>
              </View>
            )
          })}
        </Section>

        <Section
          title="Import"
          hint="Reads a theme JSON from the clipboard. Both a bare theme and an exported file are accepted."
        >
          <Button label="Import from clipboard" onPress={() => void importTheme()} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg },
    grow: { flex: 1 },
    card: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      marginBottom: space.sm,
      overflow: 'hidden',
    },
    cardActive: { borderColor: colors.accent },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
    swatches: { flexDirection: 'row', gap: 2 },
    swatch: { width: 14, height: 28, borderRadius: 3 },
    name: { color: colors.textPrimary, fontSize: font.size.md, fontWeight: '600' },
    nameActive: { color: colors.accent },
    meta: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: 2 },
    check: { color: colors.accent, fontSize: font.size.lg, fontWeight: '700' },
    actions: {
      flexDirection: 'row',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingBottom: space.md,
    },
    action: { flex: 1, paddingVertical: 8, minHeight: 34 },
  })
