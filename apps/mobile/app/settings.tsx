/**
 * Connection and device settings.
 *
 * Shows the device id and the *granted* scopes rather than the requested ones —
 * a device can be paired at a narrower scope than it asked for, and the only
 * honest answer to "what can this phone do" is what the gateway actually gave.
 */
import { useMemo } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import { useApp } from '../lib/store'
import {
  useColors,
  useThemeStore,
  useIsDark,
  availableThemes,
  font,
  radius,
  space,
  statusColor,
  type ThemeMode,
} from '../lib/theme'
import type { ColorPalette } from '@openclaw/theme'

export default function SettingsScreen() {
  const {
    identity,
    url,
    token,
    conn,
    connMessage,
    scopes,
    serverVersion,
    agents,
    models,
    push,
    pushDetail,
    notifierUrl,
    setNotifierUrl,
    enablePush,
    setUrl,
    setToken,
    connect,
    disconnect,
  } = useApp()
  const colors = useColors()
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const themeId = useThemeStore((s) => s.themeId)
  const setThemeId = useThemeStore((s) => s.setThemeId)
  const isDark = useIsDark()
  const themes = useMemo(() => availableThemes(), [])
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <ScrollView contentContainerStyle={styles.container}>
        <Section styles={styles} title="Connection">
          <Text style={[styles.status, { color: statusColor(colors, conn) }]}>{conn}</Text>
          {connMessage ? <Text style={styles.detail}>{connMessage}</Text> : null}
          {serverVersion ? <Text style={styles.detail}>gateway {serverVersion}</Text> : null}
        </Section>

        <Section styles={styles} title="Gateway URL">
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.textTertiary}
          />
          <Text style={styles.hint}>Must be wss:// unless the host is loopback.</Text>
        </Section>

        <Section styles={styles} title="Token">
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="OPENCLAW_REMOTE_TOKEN"
            placeholderTextColor={colors.textTertiary}
          />
          <Text style={styles.hint}>Stored in the Android Keystore, never in plain storage.</Text>
        </Section>

        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={() => void connect()}>
            <Text style={styles.primaryText}>{conn === 'ready' ? 'Reconnect' : 'Connect'}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={disconnect}>
            <Text style={styles.secondaryText}>Disconnect</Text>
          </Pressable>
        </View>

        <Section styles={styles} title="Push notifications">
          <Text style={[styles.status, { color: pushColor(colors, push?.status) }]}>
            {push?.status ?? 'not set up'}
          </Text>
          {pushDetail ? <Text style={styles.detail}>{pushDetail}</Text> : null}
          <TextInput
            style={[styles.input, { marginTop: space.sm }]}
            value={notifierUrl}
            onChangeText={setNotifierUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://notifier.example.com"
            placeholderTextColor={colors.textTertiary}
          />
          <Text style={styles.hint}>
            Where the notifier service runs. Registration is signed with this device&apos;s key —
            no extra credential leaves the phone.
          </Text>
          <Pressable style={[styles.secondary, { marginTop: space.sm }]} onPress={() => void enablePush()}>
            <Text style={styles.secondaryText}>Enable push</Text>
          </Pressable>
        </Section>

        <Section styles={styles} title="Appearance">
          <Text style={styles.hint}>Mode</Text>
          <View style={styles.segment}>
            {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
              <Pressable
                key={m}
                style={[styles.segmentItem, mode === m && styles.segmentItemActive]}
                onPress={() => setMode(m)}
              >
                <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
                  {m}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            System follows the device. The palette is derived from the same seeds the desktop
            uses, so both surfaces render identical colour.
          </Text>

          {themes.length > 1 ? (
            <>
              <Text style={[styles.hint, { marginTop: space.md }]}>Theme</Text>
              <View style={styles.themeList}>
                {themes.map((t) => (
                  <Pressable
                    key={t.id}
                    style={[styles.themeChip, themeId === t.id && styles.themeChipActive]}
                    onPress={() => setThemeId(t.id)}
                  >
                    {/* A swatch of the theme's own accent, so the choice is
                        visible without applying it first. */}
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: (isDark ? t.dark : t.light).accent },
                      ]}
                    />
                    <Text
                      style={[styles.themeName, themeId === t.id && styles.themeNameActive]}
                      numberOfLines={1}
                    >
                      {t.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </Section>

        <Section styles={styles} title="Device identity">
          <Text style={styles.mono} selectable>
            {identity?.deviceId ?? '…'}
          </Text>
          <Text style={styles.hint}>
            Approve this id on the gateway with `openclaw devices approve`. Revoke it with
            `openclaw devices revoke`.
          </Text>
        </Section>

        <Section styles={styles} title="Granted scopes">
          <Text style={styles.mono}>{scopes.length ? scopes.join('\n') : '(none)'}</Text>
        </Section>

        {agents.length > 0 ? (
          <Section styles={styles} title={`Agents (${agents.length})`}>
            <Text style={styles.mono}>{agents.map((a) => a.name ?? a.id).join('\n')}</Text>
          </Section>
        ) : null}

        {models.length > 0 ? (
          <Section styles={styles} title={`Models (${models.length})`}>
            <Text style={styles.mono}>
              {models
                .slice(0, 12)
                .map((m) => m.label ?? m.id)
                .join('\n')}
            </Text>
          </Section>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function pushColor(colors: ColorPalette, status?: string): string {
  if (status === 'registered') return colors.statusComplete
  if (status === 'denied' || status === 'unavailable') return colors.statusError
  if (status === 'unsupported') return colors.statusPermission
  return colors.textSecondary
}

function Section({ styles, title, children }: { styles: ReturnType<typeof makeStyles>; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.containerBg },
  container: { padding: space.lg },
  section: { marginBottom: space.xl },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: font.size.xs,
    letterSpacing: 0.5,
    marginBottom: space.sm,
    textTransform: 'uppercase',
  },
  status: { fontSize: font.size.lg, fontWeight: '700' },
  detail: { color: colors.textSecondary, fontSize: font.size.sm, marginTop: space.xs },
  hint: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: space.xs },
  mono: { color: colors.textPrimary, fontFamily: font.mono, fontSize: font.size.sm },
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
  actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.xl },
  primary: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: colors.textOnAccent, fontWeight: '700' },
  secondary: {
    flex: 1,
    backgroundColor: colors.surfacePrimary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.containerBorder,
  },
  secondaryText: { color: colors.textSecondary, fontWeight: '600' },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfacePrimary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.containerBorder,
    overflow: 'hidden',
    marginTop: space.xs,
  },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textSecondary, fontSize: font.size.sm, textTransform: 'capitalize' },
  segmentTextActive: { color: colors.textOnAccent, fontWeight: '700' },
  themeList: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  themeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.containerBorder,
    backgroundColor: colors.surfacePrimary,
  },
  themeChipActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  swatch: { width: 14, height: 14, borderRadius: radius.pill },
  themeName: { color: colors.textSecondary, fontSize: font.size.sm },
  themeNameActive: { color: colors.textPrimary, fontWeight: '700' },
  })
