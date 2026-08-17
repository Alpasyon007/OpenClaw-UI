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
import { useColors, font, radius, space, statusColor } from '../lib/theme'
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
  })
