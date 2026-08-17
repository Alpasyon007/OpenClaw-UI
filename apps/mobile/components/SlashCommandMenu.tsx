/**
 * The slash command list, above the composer.
 *
 * Rendered inline rather than in a modal so the keyboard stays up and the draft
 * keeps focus — a modal here would dismiss the keyboard on open and restore it
 * on close, which makes typing `/mo` and picking a result feel like two
 * separate interactions instead of one.
 *
 * Capped in height and scrollable: a gateway with a plugin-heavy runtime
 * advertises dozens of commands, and a list that grows to fill the screen hides
 * the message being written.
 */
import { memo, useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, elevation, font, radius, space } from '../lib/theme'
import type { SlashCommand } from '../lib/commands'

interface Props {
  commands: readonly SlashCommand[]
  onSelect: (command: SlashCommand) => void
}

function SlashCommandMenuImpl({ commands, onSelect }: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  if (commands.length === 0) return null

  return (
    <View style={styles.wrap}>
      <ScrollView
        style={styles.list}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        {commands.map((command) => (
          <Pressable
            key={command.command}
            style={styles.row}
            onPress={() => onSelect(command)}
          >
            <Text style={styles.command}>{command.command}</Text>
            <Text style={styles.description} numberOfLines={1}>
              {command.description}
            </Text>
            {/* Only gateway commands are labelled. Marking the local ones too
                would put a badge on every row, which labels nothing. */}
            {command.action === 'send' ? <Text style={styles.badge}>gateway</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

export const SlashCommandMenu = memo(SlashCommandMenuImpl)

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    wrap: {
      marginHorizontal: space.md,
      marginBottom: space.xs,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.popoverBorder,
      backgroundColor: colors.popoverBg,
      overflow: 'hidden',
      ...elevation('popover'),
    },
    list: { maxHeight: 200 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    command: {
      color: colors.textPrimary,
      fontFamily: font.mono,
      fontSize: font.size.sm,
      fontWeight: '700',
    },
    description: { color: colors.textTertiary, fontSize: font.size.xs, flex: 1 },
    badge: {
      color: colors.textTertiary,
      fontSize: 9,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      borderRadius: radius.pill,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
  })
