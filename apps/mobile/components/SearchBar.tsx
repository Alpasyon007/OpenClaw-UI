/**
 * An inline search field.
 *
 * Autofocused, because it only ever appears in response to the user asking for
 * it — a search bar that appears and then waits for a second tap before it will
 * take input is one wasted interaction every single time.
 *
 * The result count is rendered inside the field rather than above the results,
 * so "no matches" is visible without the eye leaving the thing being typed
 * into.
 */
import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, font, radius, space } from '../lib/theme'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Omitted while the query is empty — "0 results" for no query is noise. */
  resultCount?: number
  onClose?: () => void
}

function SearchBarImpl({ value, onChange, placeholder, resultCount, onClose }: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <View style={styles.wrap}>
      <View style={styles.field}>
        <Text style={styles.glyph}>⌕</Text>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="search"
        />
        {resultCount !== undefined ? (
          <Text style={[styles.count, resultCount === 0 && styles.countEmpty]}>
            {resultCount === 0 ? 'none' : resultCount}
          </Text>
        ) : null}
        {value ? (
          <Pressable onPress={() => onChange('')} hitSlop={10}>
            <Text style={styles.clear}>×</Text>
          </Pressable>
        ) : null}
      </View>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export const SearchBar = memo(SearchBarImpl)

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      backgroundColor: colors.containerBgCollapsed,
      borderBottomWidth: 1,
      borderColor: colors.containerBorder,
    },
    field: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingHorizontal: space.md,
    },
    glyph: { color: colors.textTertiary, fontSize: font.size.md },
    input: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: font.size.md,
      paddingVertical: space.sm,
    },
    count: { color: colors.textTertiary, fontSize: font.size.xs },
    countEmpty: { color: colors.statusError },
    clear: { color: colors.textTertiary, fontSize: font.size.lg, paddingHorizontal: 2 },
    cancel: { color: colors.accent, fontSize: font.size.sm },
  })
