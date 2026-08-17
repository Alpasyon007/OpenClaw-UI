/**
 * Session list — the home screen.
 *
 * Mirrors the discipline of the desktop's HistoryPicker: a slow or failing
 * fetch must never blank, delay or throw into a list the user is already
 * reading, and a row with no key is dropped rather than rendered, because an
 * id-less row once unmounted the whole React tree.
 */
import { useCallback, useEffect } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Link, useRouter } from 'expo-router'
import { gatewaySessionLabel } from '@openclaw/protocol'
import { useApp, type SessionRow } from '../lib/store'
import { ApprovalSheet } from '../components/ApprovalSheet'
import { colors, font, radius, space, statusColor } from '../lib/theme'

export default function SessionsScreen() {
  const router = useRouter()
  const {
    conn,
    connMessage,
    sessions,
    sessionsLoading,
    approvals,
    boot,
    connect,
    refreshSessions,
    resolveApproval,
    token,
  } = useApp()

  useEffect(() => {
    void boot()
  }, [boot])

  // Connect once a credential exists. Retrying automatically on failure would
  // walk straight into the gateway's auth rate limiter.
  useEffect(() => {
    if (conn === 'idle' && token) void connect()
  }, [conn, token, connect])

  const renderItem = useCallback(
    ({ item }: { item: SessionRow }) => (
      <Pressable
        style={styles.row}
        onPress={() => router.push({ pathname: '/session/[key]', params: { key: item.key } })}
      >
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {gatewaySessionLabel(item.key, item.displayName ?? undefined)}
          </Text>
          {item.hasActiveRun ? <View style={[styles.dot, { backgroundColor: colors.info }]} /> : null}
          {item.unread ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
        </View>
        <Text style={styles.rowKey} numberOfLines={1}>
          {item.key}
        </Text>
        {item.model ? <Text style={styles.rowMeta}>{item.model}</Text> : null}
      </Pressable>
    ),
    [router],
  )

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ConnectionBanner conn={conn} message={connMessage} onRetry={() => void connect()} />

      <FlatList
        data={sessions.filter((s) => !!s.key)}
        keyExtractor={(s) => s.key}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={sessionsLoading}
            onRefresh={() => void refreshSessions()}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          conn === 'ready' && !sessionsLoading ? (
            <Text style={styles.empty}>No sessions on the gateway yet.</Text>
          ) : null
        }
      />

      <ApprovalSheet
        approval={approvals[0] ?? null}
        onResolve={(id, decision) => void resolveApproval(id, decision)}
      />
    </SafeAreaView>
  )
}

function ConnectionBanner({
  conn,
  message,
  onRetry,
}: {
  conn: string
  message: string
  onRetry: () => void
}) {
  if (conn === 'ready') return null

  return (
    <View style={styles.banner}>
      <View style={styles.bannerRow}>
        {conn === 'connecting' ? <ActivityIndicator size="small" color={colors.info} /> : null}
        <Text style={[styles.bannerText, { color: statusColor(conn) }]}>
          {conn === 'connecting'
            ? 'Connecting…'
            : conn === 'pairing'
              ? 'Pairing required'
              : conn === 'error'
                ? 'Not connected'
                : 'Idle'}
        </Text>
        <View style={{ flex: 1 }} />
        <Link href="/settings" style={styles.bannerLink}>
          Settings
        </Link>
        {conn === 'error' || conn === 'pairing' ? (
          <Pressable onPress={onRetry}>
            <Text style={styles.bannerLink}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
      {message ? <Text style={styles.bannerDetail}>{message}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, gap: space.sm },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { color: colors.text, fontSize: font.size.md, fontWeight: '600', flexShrink: 1 },
  rowKey: { color: colors.textFaint, fontSize: font.size.xs, fontFamily: font.mono, marginTop: 2 },
  rowMeta: { color: colors.textMuted, fontSize: font.size.xs, marginTop: space.xs },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: space.xl },
  banner: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bannerText: { fontSize: font.size.md, fontWeight: '600' },
  bannerLink: { color: colors.accent, fontSize: font.size.sm, marginLeft: space.md },
  bannerDetail: { color: colors.textMuted, fontSize: font.size.xs, marginTop: space.xs },
})
