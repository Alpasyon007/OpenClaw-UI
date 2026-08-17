/**
 * Connection and device settings.
 *
 * Shows the device id and the *granted* scopes rather than the requested ones —
 * a device can be paired at a narrower scope than it asked for, and the only
 * honest answer to "what can this phone do" is what the gateway actually gave.
 */
import { useCallback, useMemo, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { ADMIN_SCOPES, COMPANION_SCOPES } from '@openclaw/protocol'
import type { ColorPalette } from '@openclaw/theme'
import { useApp } from '../lib/store'
import { usePrefs } from '../lib/prefs'
import { voiceCapabilities } from '../lib/voice'
import { useColors, font, radius, space, statusColor } from '../lib/theme'
import { Banner, Button, Card, DetailRow, Field, Section, Toggle } from '../components/ui'

export default function SettingsScreen() {
  const router = useRouter()
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

  const adminScope = usePrefs((s) => s.adminScope)
  const setAdminScope = usePrefs((s) => s.setAdminScope)

  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const voice = useMemo(() => voiceCapabilities(), [])
  const [reconnecting, setReconnecting] = useState(false)

  /**
   * Changing the scope request re-pairs the device.
   *
   * The gateway treats a changed *signed* scope set as a `scope-upgrade`
   * pairing request and refuses the connection until a human approves it again.
   * A toggle that silently drops a working connection is indistinguishable from
   * a bug, so the consequence is stated before anything changes.
   */
  const onToggleAdmin = useCallback(
    (next: boolean) => {
      Alert.alert(
        next ? 'Request admin scope?' : 'Drop back to companion scope?',
        next
          ? 'This device will ask the gateway for operator.admin, which unlocks the Control Center and installing skills — and grants every other operator permission along with it.\n\nThe gateway will refuse the connection until you approve this device again with `openclaw devices approve`.'
          : 'This device will go back to read, write and approvals only. You will need to approve it on the gateway again.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: next ? 'Request admin' : 'Drop admin',
            style: next ? 'destructive' : 'default',
            onPress: () => {
              setAdminScope(next)
              // Reconnect immediately. Leaving the old connection up would show
              // the old scopes while preferences claim the new ones.
              setReconnecting(true)
              void connect().finally(() => setReconnecting(false))
            },
          },
        ],
      )
    },
    [setAdminScope, connect],
  )

  const requested = adminScope ? ADMIN_SCOPES : COMPANION_SCOPES

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Section title="Connection">
          <Text style={[styles.status, { color: statusColor(colors, conn) }]}>{conn}</Text>
          {connMessage ? <Text style={styles.detail}>{connMessage}</Text> : null}
          {serverVersion ? <Text style={styles.detail}>gateway {serverVersion}</Text> : null}
        </Section>

        <Section title="Gateway URL" hint="Must be wss:// unless the host is loopback.">
          <Field
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Section>

        <Section title="Token" hint="Stored in the Android Keystore, never in plain storage.">
          <Field
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="OPENCLAW_REMOTE_TOKEN"
          />
        </Section>

        <View style={styles.actions}>
          <Button
            label={conn === 'ready' ? 'Reconnect' : 'Connect'}
            variant="primary"
            busy={reconnecting}
            onPress={() => void connect()}
            style={styles.grow}
          />
          <Button label="Disconnect" onPress={disconnect} style={styles.grow} />
        </View>

        <Section title="Permissions">
          <Toggle
            label="Request admin scope"
            tone="warning"
            value={adminScope}
            onChange={onToggleAdmin}
            hint="Needed for the Control Center and installing skills. Requires re-approving this device on the gateway."
          />
          <Card>
            <DetailRow label="Requested" value={requested.join('\n')} mono />
            <DetailRow label="Granted" value={scopes.join('\n') || '(none)'} mono />
          </Card>
          {adminScope && !scopes.includes('operator.admin') ? (
            <Banner
              tone="warning"
              message="Admin was requested but not granted. Approve this device again on the gateway."
            />
          ) : null}
        </Section>

        <Section title="Device identity">
          <Card>
            <Text style={styles.mono} selectable>
              {identity?.deviceId ?? '…'}
            </Text>
          </Card>
          <Text style={styles.hint}>
            Approve this id on the gateway with `openclaw devices approve`. Revoke it with
            `openclaw devices revoke`.
          </Text>
        </Section>

        <Section title="Push notifications">
          <Text style={[styles.status, { color: pushColor(colors, push?.status) }]}>
            {push?.status ?? 'not set up'}
          </Text>
          {pushDetail ? <Text style={styles.detail}>{pushDetail}</Text> : null}
          <Field
            value={notifierUrl}
            onChangeText={setNotifierUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://notifier.example.com"
            hint="Where the notifier service runs. Registration is signed with this device's key — no extra credential leaves the phone."
          />
          <Button label="Enable push" onPress={() => void enablePush()} />
        </Section>

        <Section title="Dictation">
          <Card>
            <DetailRow
              label="Recogniser"
              value={
                !voice.installed
                  ? 'not in this build'
                  : voice.available
                    ? 'available'
                    : 'unavailable on this device'
              }
            />
            <DetailRow
              label="On device"
              value={voice.onDevice ? 'yes — audio stays local' : 'no — uses network recognition'}
            />
          </Card>
          <Text style={styles.hint}>
            Where no local model is installed, the platform falls back to network recognition. The
            microphone button says which is in use while it is listening.
          </Text>
        </Section>

        <Section title="More">
          <Button label="Appearance" onPress={() => router.push('/appearance')} style={styles.link} />
          <Button label="Skills" onPress={() => router.push('/marketplace')} style={styles.link} />
          <Button
            label="Control Center"
            onPress={() => router.push('/control-center')}
            style={styles.link}
          />
        </Section>

        {agents.length > 0 ? (
          <Section title={`Agents (${agents.length})`}>
            <Card>
              <Text style={styles.mono}>{agents.map((a) => a.name ?? a.id).join('\n')}</Text>
            </Card>
          </Section>
        ) : null}

        {models.length > 0 ? (
          <Section title={`Models (${models.length})`}>
            <Card>
              <Text style={styles.mono}>
                {models
                  .slice(0, 12)
                  .map((m) => m.label ?? m.id)
                  .join('\n')}
              </Text>
            </Card>
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

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg },
    grow: { flex: 1 },
    status: { fontSize: font.size.lg, fontWeight: '700', textTransform: 'capitalize' },
    detail: { color: colors.textSecondary, fontSize: font.size.sm, marginTop: space.xs },
    hint: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: space.xs },
    mono: { color: colors.textPrimary, fontFamily: font.mono, fontSize: font.size.sm },
    actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.xl },
    link: { marginBottom: space.sm, borderRadius: radius.md },
  })
