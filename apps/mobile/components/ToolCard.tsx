/**
 * A tool invocation in the transcript.
 *
 * Without these the transcript shows prose with no sign the agent ran anything,
 * which reads as long unexplained pauses. The card answers one question —
 * *what is it doing right now* — and deliberately not "what did it return":
 * tool results are the bulk of a transcript's bytes and are untrusted content,
 * which the desktop already declines to carry across for the same reason.
 *
 * The summary is rendered as inert text. Nothing here is markdown, and nothing
 * is interpreted.
 */
import { memo } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { TranscriptMessage } from '@openclaw/conversation'
import type { ColorPalette } from '@openclaw/theme'
import { font, radius, space } from '../lib/theme'

function ToolCardImpl({
  message,
  colors,
}: {
  message: TranscriptMessage
  colors: ColorPalette
}) {
  const styles = makeStyles(colors)
  const running = message.status === 'streaming'
  const failed = message.status === 'error'

  return (
    <View style={[styles.card, running && styles.running, failed && styles.failed]}>
      <View style={styles.header}>
        {running ? (
          <ActivityIndicator size="small" color={colors.timelineNodeActive} />
        ) : (
          <View
            style={[
              styles.dot,
              { backgroundColor: failed ? colors.statusError : colors.statusComplete },
            ]}
          />
        )}
        <Text style={styles.name} numberOfLines={1}>
          {message.toolName ?? 'tool'}
        </Text>
      </View>

      {message.content ? (
        <Text style={styles.summary} numberOfLines={3}>
          {message.content}
        </Text>
      ) : null}
    </View>
  )
}

export const ToolCard = memo(
  ToolCardImpl,
  (a, b) =>
    a.message.content === b.message.content &&
    a.message.status === b.message.status &&
    a.message.toolName === b.message.toolName &&
    a.colors === b.colors,
)

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      backgroundColor: colors.toolBg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.toolBorder,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      gap: space.xs,
    },
    running: { borderColor: colors.toolRunningBorder, backgroundColor: colors.toolRunningBg },
    failed: { borderColor: colors.statusError },
    header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    dot: { width: 8, height: 8, borderRadius: radius.pill },
    name: { color: colors.textPrimary, fontSize: font.size.sm, fontWeight: '700' },
    summary: {
      color: colors.textSecondary,
      fontSize: font.size.xs,
      fontFamily: font.mono,
      marginLeft: space.lg,
    },
  })
