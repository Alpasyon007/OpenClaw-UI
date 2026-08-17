/**
 * One transcript row.
 *
 * Assistant text is markdown — the agent emits tables, headings, fenced code
 * and bold, and rendering it raw (as an earlier revision did) leaves `##` and
 * `**` littered through every reply. User messages are rendered as plain text
 * on purpose: they are echoed back from what the user typed, and running them
 * through a markdown parser would let a stray backtick or pipe silently reshape
 * their own words.
 *
 * Memoised on the fields that actually affect output. During streaming this
 * component re-renders on every delta, and the transcript can be hundreds of
 * rows long.
 */
import { memo, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { TranscriptMessage } from '@openclaw/conversation'
import { useColors, font, radius, space } from '../lib/theme'
import type { ColorPalette } from '@openclaw/theme'

function MessageBubbleImpl({ message }: { message: TranscriptMessage }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const markdownStyles = useMemo(() => makeMarkdownStyles(colors), [colors])
  const isUser = message.role === 'user'
  const failed = message.status === 'error'

  return (
    <View style={[styles.wrap, isUser ? styles.right : styles.left]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.userBubble : styles.assistantBubble,
          failed && styles.errorBubble,
          message.pending && styles.pending,
        ]}
      >
        {isUser ? (
          <Text style={styles.userText} selectable>
            {message.content}
          </Text>
        ) : (
          <Markdown style={markdownStyles}>{message.content}</Markdown>
        )}

        {message.status === 'streaming' ? <Text style={styles.caret}>▍</Text> : null}
      </View>

      {failed ? <Text style={styles.errorNote}>failed to send</Text> : null}
    </View>
  )
}

export const MessageBubble = memo(
  MessageBubbleImpl,
  (a, b) =>
    a.message.content === b.message.content &&
    a.message.status === b.message.status &&
    a.message.pending === b.message.pending,
)

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
  wrap: { maxWidth: '92%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  bubble: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderColor: colors.containerBorder,
  },
  userBubble: { backgroundColor: colors.userBubble },
  assistantBubble: { backgroundColor: colors.surfacePrimary },
  errorBubble: { borderColor: colors.statusError },
  pending: { opacity: 0.6 },
  userText: { color: colors.textPrimary, fontSize: font.size.md, lineHeight: 21 },
  caret: { color: colors.accent, fontSize: font.size.md },
  errorNote: { color: colors.statusError, fontSize: font.size.xs, marginTop: 2, textAlign: 'right' },
})

/**
 * Markdown theme.
 *
 * Tables and fenced code get horizontal scroll rather than wrapping: a wrapped
 * table on a phone is unreadable, and wrapped code changes what the code says.
 */
const makeMarkdownStyles = (colors: ColorPalette) => ({
  body: { color: colors.textPrimary, fontSize: font.size.md, lineHeight: 21 },
  heading1: { color: colors.textPrimary, fontSize: font.size.xl, fontWeight: '700', marginTop: space.sm },
  heading2: { color: colors.textPrimary, fontSize: font.size.lg, fontWeight: '700', marginTop: space.sm },
  heading3: { color: colors.textPrimary, fontSize: font.size.md, fontWeight: '700', marginTop: space.sm },
  strong: { fontWeight: '700', color: colors.textPrimary },
  em: { fontStyle: 'italic' },
  link: { color: colors.accent },
  blockquote: {
    backgroundColor: colors.surfaceSecondary,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  code_inline: {
    backgroundColor: colors.containerBg,
    color: colors.statusRunning,
    fontFamily: font.mono,
    fontSize: font.size.sm,
  },
  code_block: {
    backgroundColor: colors.containerBg,
    color: colors.textPrimary,
    fontFamily: font.mono,
    fontSize: font.size.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.containerBorder,
    padding: space.sm,
  },
  fence: {
    backgroundColor: colors.containerBg,
    color: colors.textPrimary,
    fontFamily: font.mono,
    fontSize: font.size.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.containerBorder,
    padding: space.sm,
  },
  table: { borderColor: colors.containerBorder, borderWidth: 1, borderRadius: radius.sm },
  thead: { backgroundColor: colors.surfaceSecondary },
  th: { padding: space.xs, color: colors.textPrimary, fontWeight: '700' },
  td: { padding: space.xs, color: colors.textSecondary },
  tr: { borderColor: colors.containerBorder },
  hr: { backgroundColor: colors.containerBorder, height: 1 },
  bullet_list: { marginVertical: space.xs },
  ordered_list: { marginVertical: space.xs },
}) as const
