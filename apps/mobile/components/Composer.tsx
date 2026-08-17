/**
 * The composer: text, attachments, slash commands and dictation.
 *
 * Extracted from the conversation screen once it acquired all four, because
 * they interact: dictation writes into the same draft the slash menu reads,
 * attachments change whether an empty draft is sendable, and a slash command
 * can clear the draft or hand it off entirely.
 *
 * The draft is owned here and reported upward only on send. Lifting it into the
 * screen made every keystroke re-render the transcript list, which on a long
 * conversation is visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, font, radius, space } from '../lib/theme'
import { AttachmentChips } from './AttachmentChips'
import { SlashCommandMenu } from './SlashCommandMenu'
import {
  captureImage,
  pickDocuments,
  pickImages,
  type DraftAttachment,
  type PickOutcome,
} from '../lib/attachments'
import {
  filterCommands,
  mergeCommands,
  slashQuery,
  type CommandAction,
  type SlashCommand,
} from '../lib/commands'
import { useVoice, voiceCapabilities } from '../lib/voice'
import { useApp } from '../lib/store'
import { Sheet, SheetRow } from './ui'

interface Props {
  enabled: boolean
  placeholder: string
  limitBytes: number
  onSend: (text: string, attachments: DraftAttachment[]) => Promise<void>
  /** A local slash command was chosen; the screen owns what each one opens. */
  onCommand: (action: CommandAction) => void
}

export function Composer({ enabled, placeholder, limitBytes, onSend, onCommand }: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [attachOpen, setAttachOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)

  const gatewayCommands = useApp((s) => s.commands)
  const commands = useMemo(() => mergeCommands(gatewayCommands), [gatewayCommands])

  const voiceStatus = useVoice((s) => s.status)
  const voiceTranscript = useVoice((s) => s.transcript)
  const voiceError = useVoice((s) => s.error)
  const startVoice = useVoice((s) => s.start)
  const stopVoice = useVoice((s) => s.stop)
  const cancelVoice = useVoice((s) => s.cancel)
  const resetVoice = useVoice((s) => s.reset)

  // Queried once: it hits the native module, and the answer cannot change
  // without the app restarting.
  const voice = useMemo(() => voiceCapabilities(), [])

  // Dictation replaces the draft rather than appending to it. Each interim
  // result is the whole utterance so far, so appending repeats every word — and
  // the user is watching the box while they speak, which makes that obvious and
  // maddening.
  useEffect(() => {
    if (voiceStatus === 'listening' && voiceTranscript) setDraft(voiceTranscript)
  }, [voiceStatus, voiceTranscript])

  const query = slashQuery(draft)
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [query, commands],
  )

  const canSend = enabled && !sending && (draft.trim().length > 0 || attachments.length > 0)

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    setSending(true)
    // Cleared optimistically: the store adds a pending row immediately, so the
    // message is visibly in the transcript before this resolves, and leaving it
    // in the box as well reads as a failed send.
    setDraft('')
    setAttachments([])
    try {
      await onSend(text, attachments)
    } finally {
      setSending(false)
    }
  }, [draft, attachments, onSend])

  const handlePick = useCallback(async (pick: () => Promise<PickOutcome>) => {
    setAttachOpen(false)
    setPicking(true)
    try {
      const outcome = await pick()
      if (outcome.ok) {
        setAttachments((current) => [...current, ...outcome.attachments])
        return
      }
      // A cancellation is a choice, not a failure — alerting on it would
      // interrupt the user for doing exactly what they meant to.
      if (outcome.reason === 'cancelled') return
      Alert.alert('Could not attach', outcome.message)
    } finally {
      setPicking(false)
    }
  }, [])

  const handleCommand = useCallback(
    (command: SlashCommand) => {
      if (command.action === 'send') {
        // A runtime command is message text. Completing it rather than sending
        // it leaves room for arguments, which most of them take.
        setDraft(`${command.command} `)
        return
      }
      setDraft('')
      onCommand(command.action)
    },
    [onCommand],
  )

  const toggleVoice = useCallback(() => {
    if (voiceStatus === 'listening' || voiceStatus === 'starting') {
      stopVoice()
      return
    }
    resetVoice()
    void startVoice()
  }, [voiceStatus, startVoice, stopVoice, resetVoice])

  return (
    <View>
      {matches.length > 0 ? (
        <SlashCommandMenu commands={matches} onSelect={handleCommand} />
      ) : null}

      <AttachmentChips
        attachments={attachments}
        limitBytes={limitBytes}
        onRemove={(id) => setAttachments((current) => current.filter((a) => a.id !== id))}
      />

      {voiceStatus === 'listening' ? (
        <Pressable style={styles.voiceBar} onPress={() => cancelVoice()}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.voiceText}>
            Listening{voice.onDevice ? ' · on device' : ' · using network recognition'} — tap to
            discard
          </Text>
        </Pressable>
      ) : null}

      {voiceStatus === 'error' && voiceError ? (
        <Pressable style={styles.voiceError} onPress={resetVoice}>
          <Text style={styles.voiceErrorText}>{voiceError}</Text>
        </Pressable>
      ) : null}

      <View style={styles.composer}>
        <Pressable
          style={styles.iconButton}
          disabled={!enabled || picking}
          onPress={() => setAttachOpen(true)}
        >
          {picking ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={styles.icon}>＋</Text>
          )}
        </Pressable>

        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          editable={enabled}
          multiline
        />

        {/* The microphone is hidden rather than disabled where the build has no
            recogniser: a permanently dead button invites repeated taps and
            explains nothing. */}
        {voice.installed && voice.available ? (
          <Pressable
            style={[styles.iconButton, voiceStatus === 'listening' && styles.iconButtonActive]}
            disabled={!enabled}
            onPress={toggleVoice}
          >
            <Text style={[styles.icon, voiceStatus === 'listening' && styles.iconActive]}>🎙</Text>
          </Pressable>
        ) : null}

        <Pressable
          style={[styles.send, !canSend && styles.sendDisabled]}
          disabled={!canSend}
          onPress={() => void handleSend()}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>

      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title="Attach">
        <SheetRow
          label="Photo library"
          detail="Images are downscaled before sending"
          onPress={() => void handlePick(pickImages)}
        />
        <SheetRow label="Take a photo" onPress={() => void handlePick(captureImage)} />
        <SheetRow
          label="File"
          detail="Sent as-is — large files may exceed the message limit"
          onPress={() => void handlePick(pickDocuments)}
        />
      </Sheet>
    </View>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: space.sm,
      padding: space.md,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
      backgroundColor: colors.surfacePrimary,
    },
    input: {
      flex: 1,
      backgroundColor: colors.containerBg,
      color: colors.textPrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      fontSize: font.size.md,
      maxHeight: 120,
    },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.containerBg,
      borderWidth: 1,
      borderColor: colors.containerBorder,
    },
    iconButtonActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
    icon: { color: colors.textSecondary, fontSize: font.size.lg },
    iconActive: { color: colors.accent },
    send: {
      backgroundColor: colors.accent,
      borderRadius: radius.md,
      paddingHorizontal: space.lg,
      height: 40,
      justifyContent: 'center',
    },
    sendDisabled: { opacity: 0.4 },
    sendText: { color: colors.textOnAccent, fontWeight: '700' },
    voiceBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      backgroundColor: colors.accentLight,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
    },
    voiceText: { color: colors.accent, fontSize: font.size.xs, flex: 1 },
    voiceError: {
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      backgroundColor: colors.surfacePrimary,
      borderTopWidth: 1,
      borderColor: colors.statusError,
    },
    voiceErrorText: { color: colors.statusError, fontSize: font.size.xs },
  })
