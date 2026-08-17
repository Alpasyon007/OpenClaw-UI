/**
 * Staged attachments, above the composer.
 *
 * Shows a thumbnail for images and a size for everything else, because the two
 * questions a user has before sending are "is that the right picture?" and "is
 * that going to be too big?" — and the second one is the difference between a
 * message that sends and a connection that drops.
 *
 * The running total turns red once the set exceeds what the gateway will
 * accept, *before* anyone presses send. Finding out afterwards means the
 * socket has already closed.
 */
import { memo, useMemo } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { encodedSize, formatBytes } from '@openclaw/protocol'
import { useColors, font, radius, space } from '../lib/theme'
import type { DraftAttachment } from '../lib/attachments'

interface Props {
  attachments: readonly DraftAttachment[]
  onRemove: (id: string) => void
  /** Live payload cap from the gateway, for the over-budget warning. */
  limitBytes: number
}

function AttachmentChipsImpl({ attachments, onRemove, limitBytes }: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const encoded = useMemo(
    () => attachments.reduce((sum, a) => sum + encodedSize(a.sizeBytes), 0),
    [attachments],
  )

  if (attachments.length === 0) return null

  // Measured against the encoded size, not the file size — base64 inflates by a
  // third, and a set that looks comfortably under the cap as bytes on disk can
  // be over it on the wire.
  const overBudget = encoded > limitBytes

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {attachments.map((attachment) => (
          <View key={attachment.id} style={styles.chip}>
            {attachment.previewUri ? (
              <Image source={{ uri: attachment.previewUri }} style={styles.thumb} />
            ) : (
              <View style={styles.fileIcon}>
                <Text style={styles.fileIconText}>
                  {extensionLabel(attachment.name, attachment.mimeType)}
                </Text>
              </View>
            )}
            <View style={styles.meta}>
              <Text style={styles.name} numberOfLines={1}>
                {attachment.name}
              </Text>
              <Text style={styles.size}>{formatBytes(attachment.sizeBytes)}</Text>
            </View>
            <Pressable onPress={() => onRemove(attachment.id)} hitSlop={10} style={styles.remove}>
              <Text style={styles.removeText}>×</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <Text style={[styles.total, overBudget && styles.totalOver]}>
        {attachments.length} attached · {formatBytes(encoded)} encoded
        {overBudget ? ` — over the ${formatBytes(limitBytes)} limit` : ''}
      </Text>
    </View>
  )
}

export const AttachmentChips = memo(AttachmentChipsImpl)

/**
 * A two-to-four character badge for a non-image file.
 *
 * Taken from the filename first and the MIME subtype only as a fallback:
 * content providers hand back `application/octet-stream` for a great many
 * files that have a perfectly good extension on their name.
 */
function extensionLabel(name: string, mimeType: string): string {
  const fromName = name.includes('.') ? name.split('.').pop() ?? '' : ''
  if (fromName && fromName.length <= 4) return fromName.toUpperCase()
  const subtype = mimeType.split('/')[1] ?? 'file'
  return subtype.slice(0, 4).toUpperCase()
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    wrap: {
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
      backgroundColor: colors.surfacePrimary,
      paddingTop: space.sm,
    },
    row: { paddingHorizontal: space.md, gap: space.sm },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      backgroundColor: colors.containerBg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingRight: space.sm,
      maxWidth: 220,
      overflow: 'hidden',
    },
    thumb: { width: 38, height: 38 },
    fileIcon: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceSecondary,
    },
    fileIconText: { color: colors.textSecondary, fontSize: 9, fontWeight: '700' },
    meta: { flexShrink: 1, paddingVertical: 4 },
    name: { color: colors.textPrimary, fontSize: font.size.xs, fontWeight: '600' },
    size: { color: colors.textTertiary, fontSize: 9 },
    remove: { paddingHorizontal: 4 },
    removeText: { color: colors.textTertiary, fontSize: font.size.lg, lineHeight: 20 },
    total: {
      color: colors.textTertiary,
      fontSize: font.size.xs,
      paddingHorizontal: space.md,
      paddingTop: space.xs,
    },
    totalOver: { color: colors.statusError, fontWeight: '700' },
  })
