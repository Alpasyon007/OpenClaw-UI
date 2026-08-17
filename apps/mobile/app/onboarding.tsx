/**
 * First run.
 *
 * Pairing a device is the one genuinely hard part of this app, and it fails in
 * a way that looks like nothing happened: the handshake succeeds, zero scopes
 * are granted, and every subsequent call returns `missing scope`. So this flow
 * is built around the pairing step rather than around a welcome screen — the
 * device id is shown early and prominently, the exact command to run is given
 * verbatim, and the connect step reports *which* of the three failure modes
 * happened instead of "could not connect".
 *
 * Skippable at any point. Someone re-installing the app already knows all of
 * this, and a wizard that cannot be dismissed is a wizard people learn to
 * resent.
 */
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import type { ColorPalette } from '@openclaw/theme'
import { useApp, DEFAULT_URL } from '../lib/store'
import { usePrefs } from '../lib/prefs'
import { useBranding, useColors, font, radius, space, statusColor } from '../lib/theme'
import { Banner, Button, Field, Section } from '../components/ui'

type Step = 'welcome' | 'gateway' | 'pair' | 'push' | 'done'

const ORDER: readonly Step[] = ['welcome', 'gateway', 'pair', 'push', 'done']

export default function OnboardingScreen() {
  const router = useRouter()
  const colors = useColors()
  const branding = useBranding()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const {
    identity,
    url,
    token,
    conn,
    connMessage,
    scopes,
    notifierUrl,
    setUrl,
    setToken,
    setNotifierUrl,
    connect,
    enablePush,
    push,
    pushDetail,
  } = useApp()
  const setOnboarded = usePrefs((s) => s.setOnboarded)

  const [step, setStep] = useState<Step>('welcome')
  const [connecting, setConnecting] = useState(false)

  const index = ORDER.indexOf(step)

  const finish = useCallback(() => {
    setOnboarded(true)
    router.replace('/')
  }, [setOnboarded, router])

  const tryConnect = useCallback(async () => {
    setConnecting(true)
    await connect()
    setConnecting(false)
  }, [connect])

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Set up',
          headerRight: () => (
            <Text style={styles.skip} onPress={finish}>
              Skip
            </Text>
          ),
        }}
      />

      <View style={styles.progress}>
        {ORDER.map((s, i) => (
          <View key={s} style={[styles.tick, i <= index && styles.tickDone]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {step === 'welcome' ? (
          <>
            <Text style={styles.glyph}>{branding.glyph}</Text>
            <Text style={styles.title}>{branding.appName} on your phone</Text>
            <Text style={styles.body}>
              Watch runs, answer tool approvals and send messages to your gateway from anywhere.
              Three things to set up: where your gateway is, a token, and one approval on the
              gateway itself.
            </Text>
            <Text style={styles.body}>
              Nothing is stored anywhere but this device. The token lives in the Android Keystore.
            </Text>
          </>
        ) : null}

        {step === 'gateway' ? (
          <>
            <Text style={styles.title}>Where is your gateway?</Text>
            <Field
              label="Gateway URL"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={DEFAULT_URL}
              hint="Must be wss:// unless the host is loopback."
            />
            <Field
              label="Token"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="OPENCLAW_REMOTE_TOKEN"
              hint="The gateway's remote token. Stored in the Keystore, never in plain storage and never logged."
            />
          </>
        ) : null}

        {step === 'pair' ? (
          <>
            <Text style={styles.title}>Approve this device</Text>
            <Text style={styles.body}>
              The gateway will not grant this phone any permissions until a human approves it once.
              Run this where your gateway lives:
            </Text>
            <View style={styles.command}>
              <Text style={styles.commandText} selectable>
                openclaw devices approve {identity?.deviceId ?? '…'}
              </Text>
            </View>
            <Text style={styles.hint}>
              That id is the fingerprint of a keypair generated on this device. The private half
              never leaves it.
            </Text>

            <Button
              label={conn === 'ready' ? 'Connected — check again' : 'Connect'}
              variant="primary"
              busy={connecting}
              onPress={() => void tryConnect()}
            />

            <View style={styles.statusBlock}>
              <Text style={[styles.status, { color: statusColor(colors, conn) }]}>{conn}</Text>
              {connMessage ? <Text style={styles.hint}>{connMessage}</Text> : null}
              {conn === 'ready' ? (
                scopes.length > 0 ? (
                  <Banner message={`Granted: ${scopes.join(', ')}`} />
                ) : (
                  // The specific failure that looks like success. Worth its own
                  // message: everything appears fine and then nothing works.
                  <Banner
                    tone="error"
                    message="Connected, but the gateway granted no permissions — the device signature did not verify. Check the token."
                  />
                )
              ) : null}
            </View>
          </>
        ) : null}

        {step === 'push' ? (
          <>
            <Text style={styles.title}>Notifications (optional)</Text>
            <Text style={styles.body}>
              A separate notifier service pushes approval requests to this phone when the app is
              closed. Without it the app still works — it just has to be open to see a request.
            </Text>
            <Field
              label="Notifier URL"
              value={notifierUrl}
              onChangeText={setNotifierUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://notifier.example.com"
              hint="Registration is signed with this device's key — no extra credential leaves the phone."
            />
            <Button label="Enable push" onPress={() => void enablePush()} />
            {push ? (
              <Text style={styles.hint}>
                {push.status}
                {pushDetail ? ` — ${pushDetail}` : ''}
              </Text>
            ) : null}
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <Text style={styles.glyph}>✓</Text>
            <Text style={styles.title}>Ready</Text>
            <Text style={styles.body}>
              Your sessions are on the next screen. Tap one to read it, send to it, or answer a
              tool approval.
            </Text>
            <Section
              title="Worth knowing"
              hint="Everything here can be changed later in Settings."
            >
              <Text style={styles.bullet}>• Tap the strip above the composer to pick a model, an agent, or change how approvals are handled.</Text>
              <Text style={styles.bullet}>• Type / in the composer for commands.</Text>
              <Text style={styles.bullet}>• The Control Center and skill installs need the admin scope, which is off by default.</Text>
            </Section>
          </>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {index > 0 ? (
          <Button
            label="Back"
            onPress={() => setStep(ORDER[Math.max(0, index - 1)])}
            style={styles.footerButton}
          />
        ) : null}
        <Button
          label={step === 'done' ? 'Start' : 'Next'}
          variant="primary"
          onPress={() => (step === 'done' ? finish() : setStep(ORDER[index + 1]))}
          style={styles.footerButton}
        />
      </View>
    </SafeAreaView>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg, gap: space.md },
    progress: { flexDirection: 'row', gap: 4, paddingHorizontal: space.lg, paddingTop: space.sm },
    tick: {
      flex: 1,
      height: 3,
      borderRadius: radius.pill,
      backgroundColor: colors.containerBorder,
    },
    tickDone: { backgroundColor: colors.accent },
    glyph: { fontSize: 48, textAlign: 'center', marginBottom: space.sm },
    title: { color: colors.textPrimary, fontSize: font.size.xl, fontWeight: '700' },
    body: { color: colors.textSecondary, fontSize: font.size.md, lineHeight: 21 },
    bullet: { color: colors.textSecondary, fontSize: font.size.sm, lineHeight: 20 },
    hint: { color: colors.textTertiary, fontSize: font.size.xs, lineHeight: 16 },
    command: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
    },
    commandText: { color: colors.textPrimary, fontFamily: font.mono, fontSize: font.size.sm },
    statusBlock: { gap: space.xs, marginTop: space.md },
    status: { fontSize: font.size.lg, fontWeight: '700', textTransform: 'capitalize' },
    skip: { color: colors.accent, fontSize: font.size.sm, marginRight: space.md },
    footer: {
      flexDirection: 'row',
      gap: space.sm,
      padding: space.lg,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
      backgroundColor: colors.containerBgCollapsed,
    },
    footerButton: { flex: 1 },
  })
