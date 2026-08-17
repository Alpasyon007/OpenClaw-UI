/**
 * The strip above the composer: who is answering, where, under what policy,
 * and what it has cost.
 *
 * A phone has no room for a desktop status bar, so this is built around one
 * question — *is anything about this session not what I expect?* Everything
 * that is normal renders quietly; the two things that are not, an `auto`
 * permission mode and a model override, are the only items that take colour.
 *
 * Tapping it opens the session settings sheet, which is the only way to change
 * any of it. The bar itself is never an input.
 */
import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { estimateCost, formatCost, formatTokens, tokenTotals } from '@openclaw/conversation'
import { useColors, font, radius, space } from '../lib/theme'
import type { PermissionMode } from '../lib/prefs'
import type { SessionMeta } from '../lib/store'

interface Props {
  meta: SessionMeta | undefined
  usage: Record<string, number> | null
  /** From preferences, when the user picked one. */
  modelOverride?: string
  agentId?: string
  permissionMode: PermissionMode
  onPress: () => void
}

function SessionStatusBarImpl({
  meta,
  usage,
  modelOverride,
  agentId,
  permissionMode,
  onPress,
}: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const model = modelOverride ?? meta?.model ?? null
  const totals = useMemo(() => tokenTotals(usage), [usage])
  const cost = useMemo(() => formatCost(estimateCost(totals, model)), [totals, model])

  const auto = permissionMode === 'auto'

  return (
    <Pressable style={styles.bar} onPress={onPress}>
      {/* Permission mode leads. It is the one field with consequences, and on a
          strip this narrow the first item is the only one guaranteed to be
          read. */}
      <View style={[styles.pill, auto && styles.pillWarning]}>
        <View style={[styles.dot, { backgroundColor: auto ? colors.statusPermission : colors.statusComplete }]} />
        <Text style={[styles.pillText, auto && styles.pillTextWarning]}>
          {auto ? 'auto-approve' : 'ask'}
        </Text>
      </View>

      {model ? (
        <Text
          style={[styles.item, modelOverride && styles.itemAccent]}
          numberOfLines={1}
        >
          {shortModel(model)}
        </Text>
      ) : null}

      {agentId ? (
        <Text style={styles.item} numberOfLines={1}>
          @{agentId}
        </Text>
      ) : null}

      {meta?.cwd ? (
        <Text style={styles.cwd} numberOfLines={1} ellipsizeMode="head">
          {meta.cwd}
        </Text>
      ) : (
        <View style={styles.grow} />
      )}

      {totals.total > 0 ? (
        <Text style={styles.item}>
          {formatTokens(totals.total)}
          {/* No cost is shown for a model with no known rate — a confident
              `$0.00` for an unpriced model is worse than no figure. */}
          {cost ? ` · ${cost}` : ''}
        </Text>
      ) : null}
    </Pressable>
  )
}

export const SessionStatusBar = memo(SessionStatusBarImpl)

/**
 * Shorten a model id to what distinguishes it.
 *
 * Ids arrive dated and sometimes region-prefixed
 * (`us.anthropic.claude-sonnet-5-20250101`), and the parts that vary between
 * the models a user actually chooses between are in the middle. Showing the
 * head truncated at 18 characters shows the same prefix for all of them.
 */
function shortModel(id: string): string {
  const withoutRegion = id.replace(/^[a-z]{2}\.[a-z]+\./i, '')
  const withoutDate = withoutRegion.replace(/-\d{8}$/, '')
  return withoutDate.replace(/^claude-/, '')
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: 6,
      backgroundColor: colors.containerBgCollapsed,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
    },
    grow: { flex: 1 },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.containerBorder,
    },
    pillWarning: { borderColor: colors.statusPermission },
    pillText: { color: colors.textSecondary, fontSize: font.size.xs },
    pillTextWarning: { color: colors.statusPermission, fontWeight: '700' },
    dot: { width: 6, height: 6, borderRadius: radius.pill },
    item: { color: colors.textSecondary, fontSize: font.size.xs, flexShrink: 1 },
    itemAccent: { color: colors.accent, fontWeight: '700' },
    cwd: {
      color: colors.textTertiary,
      fontSize: font.size.xs,
      fontFamily: font.mono,
      flex: 1,
      textAlign: 'right',
    },
  })
