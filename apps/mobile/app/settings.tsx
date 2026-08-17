/**
 * Connection and device settings.
 *
 * Shows the device id and the *granted* scopes rather than the requested ones —
 * a device can be paired at a narrower scope than it asked for, and the only
 * honest answer to "what can this phone do" is what the gateway actually gave.
 */
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import { useApp } from '../lib/store'
import { colors, font, radius, space, statusColor } from '../lib/theme'

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

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <ScrollView contentContainerStyle={styles.container}>
        <Section title="Connection">
          <Text style={[styles.status, { color: statusColor(conn) }]}>{conn}</Text>
          {connMessage ? <Text style={styles.detail}>{connMessage}</Text> : null}
          {serverVersion ? <Text style={styles.detail}>gateway {serverVersion}</Text> : null}
        </Section>

        <Section title="Gateway URL">
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.textFaint}
          />
          <Text style={styles.hint}>Must be wss:// unless the host is loopback.</Text>
        </Section>

        <Section title="Token">
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="OPENCLAW_REMOTE_TOKEN"
            placeholderTextColor={colors.textFaint}
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

        <Section title="Push notifications">
          <Text style={[styles.status, { color: pushColor(push?.status) }]}>
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
            placeholderTextColor={colors.textFaint}
          />
          <Text style={styles.hint}>
            Where the notifier service runs. Registration is signed with this device&apos;s key —
            no extra credential leaves the phone.
          </Text>
          <Pressable style={[styles.secondary, { marginTop: space.sm }]} onPress={() => void enablePush()}>
            <Text style={styles.secondaryText}>Enable push</Text>
          </Pressable>
        </Section>

        <Section title="Device identity">
          <Text style={styles.mono} selectable>
            {identity?.deviceId ?? '…'}
          </Text>
          <Text style={styles.hint}>
            Approve this id on the gateway with `openclaw devices approve`. Revoke it with
            `openclaw devices revoke`.
          </Text>
        </Section>

        <Section title="Granted scopes">
          <Text style={styles.mono}>{scopes.length ? scopes.join('\n') : '(none)'}</Text>
        </Section>

        {agents.length > 0 ? (
          <Section title={`Agents (${agents.length})`}>
            <Text style={styles.mono}>{agents.map((a) => a.name ?? a.id).join('\n')}</Text>
          </Section>
        ) : null}

        {models.length > 0 ? (
          <Section title={`Models (${models.length})`}>
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

function pushColor(status?: string): string {
  if (status === 'registered') return colors.ok
  if (status === 'denied' || status === 'unavailable') return colors.error
  if (status === 'unsupported') return colors.warn
  return colors.textMuted
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.lg },
  section: { marginBottom: space.xl },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    letterSpacing: 0.5,
    marginBottom: space.sm,
    textTransform: 'uppercase',
  },
  status: { fontSize: font.size.lg, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: font.size.sm, marginTop: space.xs },
  hint: { color: colors.textFaint, fontSize: font.size.xs, marginTop: space.xs },
  mono: { color: colors.text, fontFamily: font.mono, fontSize: font.size.sm },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
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
  primaryText: { color: colors.accentText, fontWeight: '700' },
  secondary: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.textMuted, fontWeight: '600' },
})
