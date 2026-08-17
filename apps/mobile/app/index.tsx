/**
 * Session list — the home screen.
 *
 * Mirrors the discipline of the desktop's HistoryPicker: a slow or failing
 * fetch must never blank, delay or throw into a list the user is already
 * reading, and a row with no key is dropped rather than rendered, because an
 * id-less row once unmounted the whole React tree.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Link, Stack, useRouter } from 'expo-router'
import { gatewaySessionLabel } from '@openclaw/protocol'
import { filterByFields } from '@openclaw/conversation'
import type { ColorPalette } from '@openclaw/theme'
import { useApp, type SessionRow } from '../lib/store'
import { usePrefs } from '../lib/prefs'
import { ApprovalSheet } from '../components/ApprovalSheet'
import { SearchBar } from '../components/SearchBar'
import { Sheet, SheetRow } from '../components/ui'
import { useBranding, useColors, font, radius, space, statusColor } from '../lib/theme'

export default function SessionsScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
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

  const hydrated = usePrefs((s) => s.hydrated)
  const onboarded = usePrefs((s) => s.onboarded)
  const branding = useBranding()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    void boot()
  }, [boot])

  // First run goes to the setup flow. Gated on `hydrated` so a slow read of
  // preferences does not flash the wizard at someone who finished it months
  // ago — and on the token as well, so a re-install that restored a credential
  // is not treated as a first run either.
  useEffect(() => {
    if (hydrated && !onboarded && !token) router.replace('/onboarding')
  }, [hydrated, onboarded, token, router])

  // Connect once a credential exists. Retrying automatically on failure would
  // walk straight into the gateway's auth rate limiter.
  useEffect(() => {
    if (conn === 'idle' && token) void connect()
  }, [conn, token, connect])

  const visible = useMemo(
    () =>
      filterByFields(
        sessions.filter((s) => !!s.key),
        query,
        (s) => [s.key, s.displayName, s.model, gatewaySessionLabel(s.key, s.displayName)],
      ),
    [sessions, query],
  )

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
          {item.hasActiveRun ? (
            <View style={[styles.dot, { backgroundColor: colors.statusRunning }]} />
          ) : null}
          {item.unread ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
        </View>
        <Text style={styles.rowKey} numberOfLines={1}>
          {item.key}
        </Text>
        {item.model ? <Text style={styles.rowMeta}>{item.model}</Text> : null}
      </Pressable>
    ),
    [router, styles, colors],
  )

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* In the header, not the banner: the banner hides once connected, and
          an earlier revision put the only Settings link inside it — which made
          settings unreachable in the state users are in most of the time. */}
      <Stack.Screen
        options={{
          title: branding.appName,
          // The glyph is the theme's wordmark badge, as it is on the desktop.
          // Rendered as a header element rather than prefixed onto the title
          // string so a long app name still truncates on the name and not on
          // the mark.
          headerLeft: () => <Text style={styles.glyph}>{branding.glyph}</Text>,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={() => setSearching((v) => !v)} hitSlop={8}>
                <Text style={styles.headerLink}>Search</Text>
              </Pressable>
              <Pressable onPress={() => setMenuOpen(true)} hitSlop={8}>
                <Text style={styles.headerLink}>More</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      <ConnectionBanner conn={conn} message={connMessage} onRetry={() => void connect()} />

      {searching ? (
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search sessions"
          resultCount={query.trim() ? visible.length : undefined}
          onClose={() => {
            setSearching(false)
            setQuery('')
          }}
        />
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(s) => s.key}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={sessionsLoading}
            onRefresh={() => void refreshSessions()}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          conn === 'ready' && !sessionsLoading ? (
            <Text style={styles.empty}>
              {query ? 'No sessions matched.' : 'No sessions on the gateway yet.'}
            </Text>
          ) : null
        }
      />

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title={branding.appName}>
        <SheetRow
          label="Skills"
          detail="Browse the catalogue and what your gateway has"
          onPress={() => {
            setMenuOpen(false)
            router.push('/marketplace')
          }}
        />
        <SheetRow
          label="Control Center"
          detail="Gateway health, nodes and configuration"
          onPress={() => {
            setMenuOpen(false)
            router.push('/control-center')
          }}
        />
        <SheetRow
          label="Appearance"
          detail="Themes, and the editor for writing your own"
          onPress={() => {
            setMenuOpen(false)
            router.push('/appearance')
          }}
        />
        <SheetRow
          label="Settings"
          detail="Connection, scopes, notifications"
          onPress={() => {
            setMenuOpen(false)
            router.push('/settings')
          }}
        />
        <SheetRow
          label="Run setup again"
          onPress={() => {
            setMenuOpen(false)
            router.push('/onboarding')
          }}
        />
      </Sheet>

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
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  if (conn === 'ready') return null

  return (
    <View style={styles.banner}>
      <View style={styles.bannerRow}>
        {conn === 'connecting' ? (
          <ActivityIndicator size="small" color={colors.statusRunning} />
        ) : null}
        <Text style={[styles.bannerText, { color: statusColor(colors, conn) }]}>
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

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    list: { padding: space.md, gap: space.sm },
    row: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    rowTitle: {
      color: colors.textPrimary,
      fontSize: font.size.md,
      fontWeight: '600',
      flexShrink: 1,
    },
    rowKey: {
      color: colors.textTertiary,
      fontSize: font.size.xs,
      fontFamily: font.mono,
      marginTop: 2,
    },
    rowMeta: { color: colors.textSecondary, fontSize: font.size.xs, marginTop: space.xs },
    dot: { width: 8, height: 8, borderRadius: radius.pill },
    empty: { color: colors.textSecondary, textAlign: 'center', marginTop: space.xl },
    banner: {
      backgroundColor: colors.surfacePrimary,
      borderBottomWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
    },
    headerActions: { flexDirection: 'row', gap: space.md, marginRight: space.sm },
    headerLink: { color: colors.accent, fontSize: font.size.sm },
    glyph: { fontSize: font.size.lg, marginLeft: space.md, marginRight: space.xs },
    bannerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    bannerText: { fontSize: font.size.md, fontWeight: '600' },
    bannerLink: { color: colors.accent, fontSize: font.size.sm, marginLeft: space.md },
    bannerDetail: { color: colors.textSecondary, fontSize: font.size.xs, marginTop: space.xs },
  })
