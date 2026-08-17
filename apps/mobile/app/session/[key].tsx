/**
 * Conversation — transcript, live streaming, and the composer.
 *
 * The list is inverted and fed a reversed array. That is the standard trick for
 * chat on RN: it pins to the newest row for free, and new content extends the
 * list away from the viewport instead of shifting everything the user is
 * reading. Auto-scrolling a normal list fights the user the moment they scroll
 * back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { gatewaySessionLabel } from '@openclaw/protocol'
import { useApp } from '../../lib/store'
import { ApprovalSheet } from '../../components/ApprovalSheet'
import { MessageBubble } from '../../components/MessageBubble'
import { colors, font, radius, space } from '../../lib/theme'

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ key: string }>()
  const sessionKey = params.key ?? ''

  const transcript = useApp((s) => s.transcripts[sessionKey])
  const loading = useApp((s) => s.historyLoading[sessionKey] ?? false)
  const conn = useApp((s) => s.conn)
  const approvals = useApp((s) => s.approvals)
  const loadHistory = useApp((s) => s.loadHistory)
  const send = useApp((s) => s.send)
  const abort = useApp((s) => s.abort)
  const resolveApproval = useApp((s) => s.resolveApproval)

  const [draft, setDraft] = useState('')
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (conn === 'ready' && sessionKey) void loadHistory(sessionKey)
  }, [conn, sessionKey, loadHistory])

  const messages = transcript?.messages ?? []
  const isRunning = !!transcript?.activeRunId

  // Reversed for the inverted list. Memoised so streaming does not rebuild it
  // on every token.
  const data = useMemo(() => [...messages].reverse(), [messages])

  const onSend = useCallback(() => {
    const text = draft.trim()
    if (!text || !sessionKey) return
    setDraft('')
    void send(sessionKey, text)
  }, [draft, sessionKey, send])

  // Approvals raised by this session come first; a global one still shows.
  const approval =
    approvals.find((a) => a.request.sessionKey === sessionKey) ?? approvals[0] ?? null

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: gatewaySessionLabel(sessionKey) }} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {loading && messages.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : (
          <FlatList
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageBubble message={item} />}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
            keyboardDismissMode="interactive"
          />
        )}

        {isRunning ? (
          <Pressable style={styles.stopBar} onPress={() => void abort(sessionKey)}>
            <ActivityIndicator size="small" color={colors.info} />
            <Text style={styles.stopText}>Running — tap to stop</Text>
          </Pressable>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={conn === 'ready' ? 'Message the agent…' : 'Not connected'}
            placeholderTextColor={colors.textFaint}
            editable={conn === 'ready'}
            multiline
          />
          <Pressable
            style={[styles.send, (!draft.trim() || conn !== 'ready') && styles.sendDisabled]}
            disabled={!draft.trim() || conn !== 'ready'}
            onPress={onSend}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <ApprovalSheet
        approval={approval}
        onResolve={(id, decision) => void resolveApproval(id, decision)}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: space.md, gap: space.sm },
  // An inverted FlatList rotates its container 180°, and children inherit that
  // — including ListEmptyComponent, which otherwise renders upside down and
  // mirrored. Counter-rotating is the fix; a scaleY flip corrects only one axis
  // and leaves the text reversed.
  empty: {
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: space.xl,
    transform: [{ rotate: '180deg' }],
  },
  bubbleWrap: { maxWidth: '88%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  bubble: { borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: colors.border },
  userBubble: { backgroundColor: colors.userBubble },
  assistantBubble: { backgroundColor: colors.assistantBubble },
  errorBubble: { borderColor: colors.error },
  pendingBubble: { opacity: 0.6 },
  bubbleText: { color: colors.text, fontSize: font.size.md, lineHeight: 20 },
  caret: { color: colors.accent, fontSize: font.size.md },
  errorNote: { color: colors.error, fontSize: font.size.xs, marginTop: 2, textAlign: 'right' },
  stopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  stopText: { color: colors.info, fontSize: font.size.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.size.md,
    maxHeight: 120,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.accentText, fontWeight: '700' },
})
