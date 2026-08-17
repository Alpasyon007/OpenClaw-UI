/**
 * Marketplace — browse skills, and install them when this device is allowed to.
 *
 * The catalogue runs to well over a thousand entries, which shapes almost every
 * decision here: the filter is computed once per query rather than per row, the
 * list is virtualised with a fixed row height so it can jump rather than
 * measure, and rows are memoised so a search keystroke does not re-render a
 * thousand cards.
 *
 * What the gateway already has sorts to the top, and it is the only group whose
 * rows answer a question the user cannot answer for themselves.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import type { CatalogEntry } from '@openclaw/marketplace'
import type { ColorPalette } from '@openclaw/theme'
import { filterByFields } from '@openclaw/conversation'
import { useColors, font, radius, space } from '../lib/theme'
import { categoriesOf, useMarketplace, type InstallState } from '../lib/marketplace'
import { Banner, Button, Chip, EmptyState, Loading } from '../components/ui'
import { SearchBar } from '../components/SearchBar'

const ROW_HEIGHT = 108

export default function MarketplaceScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const {
    entries,
    installed,
    loading,
    warnings,
    installBlocked,
    install,
    installError,
    load,
    installSkill,
    uninstallSkill,
  } = useMarketplace()

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const categories = useMemo(() => categoriesOf(entries), [entries])

  const visible = useMemo(() => {
    const byCategory = category ? entries.filter((e) => e.category === category) : entries
    return filterByFields(byCategory, query, (e) => [
      e.name,
      e.description,
      e.installName,
      e.author,
      ...e.tags,
    ])
  }, [entries, category, query])

  const installedSet = useMemo(() => new Set(installed.map((n) => n.toLowerCase())), [installed])

  const renderItem = useCallback(
    ({ item }: { item: CatalogEntry }) => (
      <SkillRow
        entry={item}
        state={install[item.installName] ?? 'idle'}
        error={installError[item.installName]}
        installedAlready={installedSet.has(item.installName.toLowerCase())}
        canInstall={!installBlocked}
        onInstall={() => void installSkill(item)}
        onUninstall={() => void uninstallSkill(item.installName)}
      />
    ),
    [install, installError, installedSet, installBlocked, installSkill, uninstallSkill],
  )

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Skills',
          headerRight: () => (
            <Pressable onPress={() => router.push('/skill-builder')} hitSlop={8}>
              <Text style={styles.headerAction}>New</Text>
            </Pressable>
          ),
        }}
      />

      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder="Search skills"
        resultCount={query.trim() ? visible.length : undefined}
      />

      {categories.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          <Chip label="All" active={category === null} onPress={() => setCategory(null)} />
          {categories.map((name) => (
            <Chip
              key={name}
              label={name}
              active={category === name}
              onPress={() => setCategory(category === name ? null : name)}
            />
          ))}
        </ScrollView>
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(entry) => entry.id}
        renderItem={renderItem}
        // A fixed height is a small lie — a long description wraps — but it is
        // what lets a 1,400-row list scroll without measuring, and the row is
        // clipped to match so nothing is actually cut off.
        getItemLayout={(_, index) => ({
          length: ROW_HEIGHT,
          offset: ROW_HEIGHT * index,
          index,
        })}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void load({ force: true })}
            tintColor={colors.textSecondary}
          />
        }
        ListHeaderComponent={
          <View>
            {installBlocked ? <Banner tone="warning" message={installBlocked} /> : null}
            {warnings.length > 0 ? (
              <Banner message={warnings.join(' · ')} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <Loading label="Fetching the catalogue…" />
          ) : (
            <EmptyState
              title={query ? 'Nothing matched' : 'No skills found'}
              detail={
                query
                  ? 'Try a different search.'
                  : 'The catalogue could not be reached. Pull down to try again.'
              }
            />
          )
        }
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
      />
    </SafeAreaView>
  )
}

const SkillRow = ({
  entry,
  state,
  error,
  installedAlready,
  canInstall,
  onInstall,
  onUninstall,
}: {
  entry: CatalogEntry
  state: InstallState
  error?: string
  installedAlready: boolean
  canInstall: boolean
  onInstall: () => void
  onUninstall: () => void
}) => {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const onGateway = entry.installMode === 'gateway'
  const blocked = onGateway && entry.gatewayReady === false

  return (
    <View style={[styles.row, blocked && styles.rowBlocked]}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.name}
        </Text>
        {onGateway ? (
          <View style={[styles.tag, blocked ? styles.tagBlocked : styles.tagReady]}>
            <Text style={[styles.tagText, blocked ? styles.tagTextBlocked : styles.tagTextReady]}>
              {blocked ? 'blocked' : 'installed'}
            </Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.rowDescription} numberOfLines={2}>
        {/* A blocked skill's reason replaces its description: "macOS only" is
            the only thing about that row worth reading. */}
        {blocked ? (entry.gatewayBlockReason ?? 'Present but not runnable.') : entry.description}
      </Text>

      <View style={styles.rowFooter}>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {entry.marketplace} · {entry.author}
        </Text>
        <View style={styles.grow} />

        {onGateway ? (
          canInstall ? (
            <Button label="Remove" variant="danger" onPress={onUninstall} style={styles.action} />
          ) : null
        ) : entry.installMode === 'clawhub' ? (
          // Nothing here can install a ClawHub skill, so the row shows the one
          // line that will, rather than a button that fails.
          <Text style={styles.command} numberOfLines={1}>
            {entry.installCommand}
          </Text>
        ) : (
          <Button
            label={
              state === 'installed' || installedAlready
                ? 'Installed'
                : state === 'failed'
                  ? 'Retry'
                  : 'Install'
            }
            variant={state === 'failed' ? 'danger' : 'secondary'}
            busy={state === 'installing'}
            disabled={!canInstall || state === 'installed' || installedAlready}
            onPress={onInstall}
            style={styles.action}
          />
        )}
      </View>

      {error ? (
        <Text style={styles.error} numberOfLines={2}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    grow: { flex: 1 },
    headerAction: { color: colors.accent, fontSize: font.size.sm, marginRight: space.md },
    chips: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm },
    list: { padding: space.md, gap: space.sm },
    row: {
      height: ROW_HEIGHT,
      overflow: 'hidden',
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
      justifyContent: 'space-between',
    },
    rowBlocked: { borderColor: colors.statusPermission },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    rowName: { color: colors.textPrimary, fontSize: font.size.md, fontWeight: '600', flexShrink: 1 },
    rowDescription: { color: colors.textSecondary, fontSize: font.size.xs, lineHeight: 16 },
    rowFooter: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    rowMeta: { color: colors.textTertiary, fontSize: 10, flexShrink: 1 },
    action: { paddingVertical: 6, paddingHorizontal: space.md, minHeight: 30 },
    command: { color: colors.textTertiary, fontFamily: font.mono, fontSize: 10, flexShrink: 1 },
    tag: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: space.sm, paddingVertical: 1 },
    tagReady: { borderColor: colors.statusComplete },
    tagBlocked: { borderColor: colors.statusPermission },
    tagText: { fontSize: 9, fontWeight: '700' },
    tagTextReady: { color: colors.statusComplete },
    tagTextBlocked: { color: colors.statusPermission },
    error: { color: colors.statusError, fontSize: 10 },
  })
