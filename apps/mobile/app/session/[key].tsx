/**
 * Conversation — transcript, live streaming, and the composer.
 *
 * The list is inverted and fed a reversed array. That is the standard trick for
 * chat on RN: it pins to the newest row for free, and new content extends the
 * list away from the viewport instead of shifting everything the user is
 * reading. Auto-scrolling a normal list fights the user the moment they scroll
 * back.
 *
 * The screen owns navigation-shaped state — which sheet is open, whether search
 * is showing — and nothing else. The draft lives in {@link Composer} so typing
 * does not re-render the transcript, and everything durable lives in the store
 * or in preferences.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { gatewaySessionLabel } from '@openclaw/protocol'
import { emptyTranscript, searchMessages, type TranscriptMessage } from '@openclaw/conversation'
import type { ColorPalette } from '@openclaw/theme'
import { useApp } from '../../lib/store'
import { usePrefs, permissionModeFor } from '../../lib/prefs'
import { useBranding, useColors, font, radius, space } from '../../lib/theme'
import { shareTranscript } from '../../lib/share'
import type { CommandAction } from '../../lib/commands'
import type { DraftAttachment } from '../../lib/attachments'
import { ApprovalSheet } from '../../components/ApprovalSheet'
import { Composer } from '../../components/Composer'
import { MessageBubble } from '../../components/MessageBubble'
import { SearchBar } from '../../components/SearchBar'
import { SessionSettingsSheet } from '../../components/SessionSettingsSheet'
import { SessionStatusBar } from '../../components/SessionStatusBar'
import { ToolCard } from '../../components/ToolCard'

type SheetTab = 'model' | 'agent' | 'permissions' | 'cost'

/**
 * Stable empty list for a session with no transcript yet.
 *
 * `emptyTranscript().messages` would be a fresh array on every render, which
 * defeats the `useMemo` that builds the reversed list — so the transcript would
 * rebuild on each keystroke elsewhere in the tree.
 */
const NO_MESSAGES: readonly TranscriptMessage[] = []

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ key: string }>()
  const sessionKey = params.key ?? ''
  const router = useRouter()

  const transcript = useApp((s) => s.transcripts[sessionKey])
  const loading = useApp((s) => s.historyLoading[sessionKey] ?? false)
  const conn = useApp((s) => s.conn)
  const maxPayload = useApp((s) => s.maxPayload)
  const meta = useApp((s) => s.sessionMeta[sessionKey])
  const approvals = useApp((s) => s.approvals)
  const loadHistory = useApp((s) => s.loadHistory)
  const loadSessionMeta = useApp((s) => s.loadSessionMeta)
  const send = useApp((s) => s.send)
  const abort = useApp((s) => s.abort)
  const resolveApproval = useApp((s) => s.resolveApproval)
  const watchSession = useApp((s) => s.watchSession)
  const unwatchSession = useApp((s) => s.unwatchSession)

  const sessionPrefs = usePrefs((s) => s.sessions[sessionKey])
  const permissionMode = usePrefs((s) => permissionModeFor(s.sessions, sessionKey))

  const branding = useBranding()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const listRef = useRef<FlatList<TranscriptMessage>>(null)

  const [sheet, setSheet] = useState<SheetTab | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (conn !== 'ready' || !sessionKey) return
    void loadHistory(sessionKey)
    void loadSessionMeta(sessionKey)
  }, [conn, sessionKey, loadHistory, loadSessionMeta])

  // Tool activity reaches only subscribed clients. Subscribing on mount and
  // releasing on unmount keeps the gateway from fanning out events for every
  // session the phone has ever opened.
  useEffect(() => {
    if (conn !== 'ready' || !sessionKey) return
    void watchSession(sessionKey)
    return () => {
      void unwatchSession(sessionKey)
    }
  }, [conn, sessionKey, watchSession, unwatchSession])

  const messages = transcript?.messages ?? NO_MESSAGES
  const isRunning = !!transcript?.activeRunId

  const hits = useMemo(
    () => (searching && query.trim() ? searchMessages(messages, query) : []),
    [searching, query, messages],
  )

  // Reversed for the inverted list. Memoised so streaming does not rebuild it
  // on every token.
  const data = useMemo(() => [...messages].reverse(), [messages])

  const onSend = useCallback(
    async (text: string, attachments: DraftAttachment[]) => {
      if (!sessionKey) return
      const outcome = await send(sessionKey, text, attachments)
      if (!outcome.ok) {
        Alert.alert('Could not send', outcome.error)
        return
      }
      if (outcome.modelIgnored) {
        // The message went, but not to the model the status bar claims. Saying
        // nothing would leave the bar lying for the rest of the session.
        Alert.alert(
          'Model override ignored',
          'This gateway does not accept a per-message model. The message was sent using the session’s own model.',
        )
      }
    },
    [sessionKey, send],
  )

  const onExport = useCallback(async () => {
    const outcome = await shareTranscript(messages, {
      sessionKey,
      title: gatewaySessionLabel(sessionKey),
      assistantName: branding.assistantName,
      model: sessionPrefs?.model ?? meta?.model ?? null,
      usage: transcript?.usage ?? null,
    })
    if (!outcome.ok) {
      Alert.alert('Export failed', outcome.error)
      return
    }
    if (outcome.via === 'clipboard') {
      Alert.alert('Copied', 'No app could take the file, so the transcript was copied instead.')
    }
  }, [messages, sessionKey, branding.assistantName, sessionPrefs?.model, meta?.model, transcript?.usage])

  const onCommand = useCallback(
    (action: CommandAction) => {
      switch (action) {
        case 'model':
        case 'agent':
        case 'permissions':
        case 'cost':
          setSheet(action)
          return
        case 'search':
          setSearching(true)
          return
        case 'export':
          void onExport()
          return
        case 'skills':
          router.push('/marketplace')
          return
        case 'clear':
          // Local only, and the confirmation says so. The gateway keeps its own
          // history and this cannot touch it — a "cleared" transcript that
          // reappears on the next reconnect would look like data loss undone by
          // accident.
          Alert.alert(
            'Clear on this device?',
            'Removes the transcript from this phone. The gateway keeps its own copy, and reopening the session will load it again.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Clear',
                style: 'destructive',
                onPress: () =>
                  useApp.setState((s) => ({
                    transcripts: { ...s.transcripts, [sessionKey]: emptyTranscript() },
                  })),
              },
            ],
          )
          return
        default:
          return
      }
    },
    [onExport, router, sessionKey],
  )

  // Stable, so the memoised status bar is not re-rendered by every transcript
  // delta that passes through this component.
  const openSettings = useCallback(() => setSheet('model'), [])

  // Approvals raised by this session come first; a global one still shows.
  const approval =
    approvals.find((a) => a.request.sessionKey === sessionKey) ?? approvals[0] ?? null

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: gatewaySessionLabel(sessionKey),
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={() => setSearching((v) => !v)} hitSlop={8}>
                <Text style={styles.headerAction}>Search</Text>
              </Pressable>
              <Pressable onPress={() => void onExport()} hitSlop={8}>
                <Text style={styles.headerAction}>Export</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      {searching ? (
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search this conversation"
          resultCount={query.trim() ? hits.length : undefined}
          onClose={() => {
            setSearching(false)
            setQuery('')
          }}
        />
      ) : null}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {loading && messages.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : searching && query.trim() ? (
          <FlatList
            data={hits}
            keyExtractor={(hit) => hit.message.id}
            renderItem={({ item }) => (
              <Pressable
                style={styles.hit}
                onPress={() => {
                  setSearching(false)
                  setQuery('')
                  // The list is inverted, so the index has to be mirrored.
                  const target = messages.length - 1 - item.index
                  listRef.current?.scrollToIndex({ index: target, animated: true })
                }}
              >
                <Text style={styles.hitRole}>
                  {item.message.role === 'user' ? 'You' : branding.assistantName}
                </Text>
                <Text style={styles.hitSnippet} numberOfLines={3}>
                  {item.snippet}
                </Text>
              </Pressable>
            )}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<Text style={styles.empty}>Nothing matched.</Text>}
            keyboardShouldPersistTaps="handled"
          />
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) =>
              item.role === 'tool' ? (
                <ToolCard message={item} colors={colors} />
              ) : (
                <MessageBubble message={item} />
              )
            }
            contentContainerStyle={styles.list}
            // Deliberately *not* `branding.greeting`. That field is authored
            // for the desktop's empty workspace ("Choose a folder to get
            // started") and reads as an instruction the phone cannot follow.
            // The branding fields whose meaning survives the change of surface
            // — appName, assistantName, glyph, inputPlaceholder — are the ones
            // used here.
            ListEmptyComponent={
              <Text style={styles.empty}>Nothing here yet. Message {branding.assistantName} to start.</Text>
            }
            keyboardDismissMode="interactive"
            // Rows are variable height, so an index the list has not measured
            // yet cannot be scrolled to directly. Failing softly and retrying
            // after a render beats throwing out of a search result tap.
            onScrollToIndexFailed={({ index }) => {
              setTimeout(() => listRef.current?.scrollToIndex({ index, animated: false }), 80)
            }}
          />
        )}

        {isRunning ? (
          <Pressable style={styles.stopBar} onPress={() => void abort(sessionKey)}>
            <ActivityIndicator size="small" color={colors.statusRunning} />
            <Text style={styles.stopText}>Running — tap to stop</Text>
          </Pressable>
        ) : null}

        <SessionStatusBar
          meta={meta}
          usage={transcript?.usage ?? null}
          modelOverride={sessionPrefs?.model}
          agentId={sessionPrefs?.agentId ?? meta?.agentId ?? undefined}
          permissionMode={permissionMode}
          onPress={openSettings}
        />

        <Composer
          enabled={conn === 'ready'}
          placeholder={conn === 'ready' ? branding.inputPlaceholder : 'Not connected'}
          limitBytes={maxPayload}
          onSend={onSend}
          onCommand={onCommand}
        />
      </KeyboardAvoidingView>

      <SessionSettingsSheet
        sessionKey={sessionKey}
        visible={sheet !== null}
        tab={sheet ?? 'model'}
        onClose={() => setSheet(null)}
      />

      <ApprovalSheet
        approval={approval}
        onResolve={(id, decision) => void resolveApproval(id, decision)}
      />
    </SafeAreaView>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: space.md, gap: space.sm },
    // An inverted FlatList rotates its container 180°, and children inherit
    // that — including ListEmptyComponent, which otherwise renders upside down
    // and mirrored. Counter-rotating is the fix; a scaleY flip corrects only
    // one axis and leaves the text reversed.
    empty: {
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: space.xl,
      transform: [{ rotate: '180deg' }],
    },
    stopBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      backgroundColor: colors.surfacePrimary,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
    },
    stopText: { color: colors.statusRunning, fontSize: font.size.sm },
    headerActions: { flexDirection: 'row', gap: space.md, marginRight: space.sm },
    headerAction: { color: colors.accent, fontSize: font.size.sm },
    hit: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
    },
    hitRole: { color: colors.textTertiary, fontSize: font.size.xs, marginBottom: 2 },
    hitSnippet: { color: colors.textPrimary, fontSize: font.size.sm },
  })
