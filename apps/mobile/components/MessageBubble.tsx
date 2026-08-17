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
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { TranscriptMessage } from '@openclaw/conversation'
import { colors, font, radius, space } from '../lib/theme'

function MessageBubbleImpl({ message }: { message: TranscriptMessage }) {
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

const styles = StyleSheet.create({
  wrap: { maxWidth: '92%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  bubble: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  userBubble: { backgroundColor: colors.userBubble },
  assistantBubble: { backgroundColor: colors.assistantBubble },
  errorBubble: { borderColor: colors.error },
  pending: { opacity: 0.6 },
  userText: { color: colors.text, fontSize: font.size.md, lineHeight: 21 },
  caret: { color: colors.accent, fontSize: font.size.md },
  errorNote: { color: colors.error, fontSize: font.size.xs, marginTop: 2, textAlign: 'right' },
})

/**
 * Markdown theme.
 *
 * Tables and fenced code get horizontal scroll rather than wrapping: a wrapped
 * table on a phone is unreadable, and wrapped code changes what the code says.
 */
const markdownStyles = {
  body: { color: colors.text, fontSize: font.size.md, lineHeight: 21 },
  heading1: { color: colors.text, fontSize: font.size.xl, fontWeight: '700', marginTop: space.sm },
  heading2: { color: colors.text, fontSize: font.size.lg, fontWeight: '700', marginTop: space.sm },
  heading3: { color: colors.text, fontSize: font.size.md, fontWeight: '700', marginTop: space.sm },
  strong: { fontWeight: '700', color: colors.text },
  em: { fontStyle: 'italic' },
  link: { color: colors.accent },
  blockquote: {
    backgroundColor: colors.surfaceRaised,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  code_inline: {
    backgroundColor: colors.bg,
    color: colors.info,
    fontFamily: font.mono,
    fontSize: font.size.sm,
  },
  code_block: {
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.size.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.sm,
  },
  fence: {
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.size.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.sm,
  },
  table: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm },
  thead: { backgroundColor: colors.surfaceRaised },
  th: { padding: space.xs, color: colors.text, fontWeight: '700' },
  td: { padding: space.xs, color: colors.textMuted },
  tr: { borderColor: colors.border },
  hr: { backgroundColor: colors.border, height: 1 },
  bullet_list: { marginVertical: space.xs },
  ordered_list: { marginVertical: space.xs },
} as const
