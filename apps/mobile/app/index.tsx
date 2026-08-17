/**
 * Connection screen.
 *
 * Deliberately shows the mechanism rather than hiding it: device id, granted
 * scopes, and the raw pairing state. This is the screen that proves the whole
 * stack runs under Hermes — Ed25519 signing, base64url, the WebSocket handshake
 * and schema validation — so it is more useful reporting what happened than
 * looking finished.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { COMPANION_SCOPES, M } from '@openclaw/protocol'
import { GatewayClient, GatewayConnectError, type DeviceIdentity } from '@openclaw/gateway-client'
import { loadOrCreateIdentity } from '../lib/identity'

const DEFAULT_URL = 'wss://openclaw-gateway-production-091e.up.railway.app'

type Phase = 'booting' | 'idle' | 'connecting' | 'ready' | 'pairing' | 'error'

interface SessionRow {
  key: string
  displayName?: string | null
}

export default function ConnectScreen() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null)
  const [url, setUrl] = useState(DEFAULT_URL)
  const [token, setToken] = useState('')
  const [phase, setPhase] = useState<Phase>('booting')
  const [message, setMessage] = useState('')
  const [scopes, setScopes] = useState<readonly string[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [log, setLog] = useState<string[]>([])

  const addLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-40), line])
  }, [])

  useEffect(() => {
    // Key generation is the first real exercise of the crypto path on-device.
    loadOrCreateIdentity()
      .then(({ identity: id, created }) => {
        setIdentity(id)
        setPhase('idle')
        addLog(created ? 'generated a new device identity' : 'loaded device identity from keystore')
      })
      .catch((err: unknown) => {
        setPhase('error')
        setMessage(`identity failed: ${String(err)}`)
      })
  }, [addLog])

  const connect = useCallback(async () => {
    if (!identity) return
    setPhase('connecting')
    setMessage('')
    setSessions([])

    const client = new GatewayClient({
      url,
      identity,
      auth: { token: token.trim() },
      scopes: COMPANION_SCOPES,
      client: {
        id: 'openclaw-android',
        version: '0.1.0',
        platform: 'android',
        mode: 'ui',
        deviceFamily: 'Emulator',
        displayName: 'OpenClaw Companion',
      },
      handshakeTimeoutMs: 20_000,
      onLog: addLog,
    })

    try {
      const hello = await client.connect()
      setScopes(client.getGrantedScopes())
      addLog(`hello-ok: protocol ${hello.protocol}, server ${hello.server?.version ?? '?'}`)

      if (client.getGrantedScopes().length === 0) {
        setPhase('error')
        setMessage('Connected, but zero scopes were granted — the device signature did not verify.')
        client.close()
        return
      }

      const result = await client.request<{ sessions?: SessionRow[] }>(M.SESSIONS_LIST, {
        limit: 20,
        offset: 0,
      })
      setSessions(result.sessions ?? [])
      setPhase('ready')
      addLog(`sessions.list returned ${result.sessions?.length ?? 0} row(s)`)
      client.close()
    } catch (err) {
      if (err instanceof GatewayConnectError && err.rejection.kind === 'pairing-required') {
        setPhase('pairing')
        setMessage('This device needs approving once on the gateway, then try again.')
        return
      }
      setPhase('error')
      setMessage(String(err))
    }
  }, [identity, url, token, addLog])

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.label}>Device ID</Text>
        <Text style={styles.mono} selectable>
          {identity?.deviceId ?? '…'}
        </Text>

        <Text style={styles.label}>Gateway URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor="#5a5a70"
        />

        <Text style={styles.label}>Token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="OPENCLAW_REMOTE_TOKEN"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor="#5a5a70"
        />

        <Pressable
          style={[styles.button, (phase === 'connecting' || !identity) && styles.buttonDisabled]}
          disabled={phase === 'connecting' || !identity}
          onPress={connect}
        >
          {phase === 'connecting' ? (
            <ActivityIndicator color="#0b0b10" />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </Pressable>

        <StatusLine phase={phase} message={message} />

        {scopes.length > 0 && (
          <>
            <Text style={styles.label}>Granted scopes</Text>
            <Text style={styles.mono}>{scopes.join('\n')}</Text>
          </>
        )}

        {sessions.length > 0 && (
          <>
            <Text style={styles.label}>Sessions ({sessions.length})</Text>
            {sessions.map((s) => (
              <View key={s.key} style={styles.row}>
                <Text style={styles.rowTitle}>{s.displayName || '(untitled)'}</Text>
                <Text style={styles.rowKey} numberOfLines={1}>
                  {s.key}
                </Text>
              </View>
            ))}
          </>
        )}

        <Text style={styles.label}>Log</Text>
        <Text style={styles.logText}>{log.join('\n') || '—'}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

function StatusLine({ phase, message }: { phase: Phase; message: string }) {
  const color =
    phase === 'ready' ? '#4ade80' : phase === 'pairing' ? '#fbbf24' : phase === 'error' ? '#f87171' : '#9898b0'
  const text =
    phase === 'ready'
      ? 'Connected'
      : phase === 'pairing'
        ? 'Pairing required'
        : phase === 'error'
          ? 'Failed'
          : phase === 'connecting'
            ? 'Connecting…'
            : phase === 'booting'
              ? 'Preparing device identity…'
              : 'Idle'

  return (
    <View style={styles.status}>
      <Text style={[styles.statusText, { color }]}>{text}</Text>
      {message ? <Text style={styles.statusDetail}>{message}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b0b10' },
  container: { padding: 16, gap: 4 },
  label: { color: '#9898b0', fontSize: 12, marginTop: 16, marginBottom: 4, letterSpacing: 0.5 },
  mono: { color: '#e6e6f0', fontFamily: 'monospace', fontSize: 12 },
  input: {
    backgroundColor: '#16161f',
    color: '#e6e6f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#26263a',
  },
  button: {
    backgroundColor: '#c9a227',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#0b0b10', fontWeight: '700', fontSize: 15 },
  status: { marginTop: 16 },
  statusText: { fontSize: 15, fontWeight: '600' },
  statusDetail: { color: '#9898b0', fontSize: 12, marginTop: 4 },
  row: {
    backgroundColor: '#16161f',
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#26263a',
  },
  rowTitle: { color: '#e6e6f0', fontSize: 13, fontWeight: '600' },
  rowKey: { color: '#6f6f8a', fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  logText: { color: '#6f6f8a', fontSize: 10, fontFamily: 'monospace' },
})
