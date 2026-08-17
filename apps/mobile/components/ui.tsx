/**
 * The small shared pieces every screen ended up re-declaring.
 *
 * Each one takes its colours from {@link useColors} rather than a prop, so a
 * theme change repaints them without any screen having to thread a palette
 * through. Styles are built inside the component and memoised on the palette —
 * a module-level `StyleSheet.create` cannot see theme tokens at all, which is
 * how the first version of these ended up with hardcoded greys that ignored the
 * theme entirely.
 */
import { useMemo, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, elevation, font, radius, space } from '../lib/theme'

// ─── Layout ───

export function Section({
  title,
  hint,
  right,
  children,
}: {
  title?: string
  hint?: string
  right?: ReactNode
  children?: ReactNode
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.section}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={styles.grow} />
          {right}
        </View>
      ) : null}
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return <View style={[styles.card, style]}>{children}</View>
}

/** A labelled key/value line, for read-only detail lists. */
export function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.mono]} selectable numberOfLines={4}>
        {value}
      </Text>
    </View>
  )
}

// ─── Controls ───

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  busy,
  style,
}: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  busy?: boolean
  style?: object
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const isPrimary = variant === 'primary'
  const isDanger = variant === 'danger'

  return (
    <Pressable
      style={[
        styles.button,
        isPrimary && styles.buttonPrimary,
        isDanger && styles.buttonDanger,
        (disabled || busy) && styles.buttonDisabled,
        style,
      ]}
      disabled={disabled || busy}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator size="small" color={isPrimary ? colors.textOnAccent : colors.textSecondary} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            isPrimary && styles.buttonTextPrimary,
            isDanger && styles.buttonTextDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )
}

export function Field({
  label,
  hint,
  ...input
}: { label?: string; hint?: string } & TextInputProps) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textTertiary}
        {...input}
        style={[styles.input, input.multiline && styles.inputMultiline, input.style]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  )
}

/** A horizontal set of mutually exclusive options. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  labels?: Partial<Record<T, string>>
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.segment}>
      {options.map((option) => (
        <Pressable
          key={option}
          style={[styles.segmentItem, value === option && styles.segmentItemActive]}
          onPress={() => onChange(option)}
        >
          <Text style={[styles.segmentText, value === option && styles.segmentTextActive]}>
            {labels?.[option] ?? option}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
  tone = 'default',
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  tone?: 'default' | 'warning'
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)}>
      <View style={styles.grow}>
        <Text
          style={[
            styles.toggleLabel,
            tone === 'warning' && value && { color: colors.statusPermission },
          ]}
        >
          {label}
        </Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View
        style={[
          styles.switchTrack,
          value && {
            backgroundColor: tone === 'warning' ? colors.statusPermission : colors.accent,
          },
        ]}
      >
        <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
      </View>
    </Pressable>
  )
}

export function Chip({
  label,
  active,
  onPress,
  tone,
}: {
  label: string
  active?: boolean
  onPress?: () => void
  tone?: string
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive, tone ? { borderColor: tone } : null]}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text
        style={[styles.chipText, active && styles.chipTextActive, tone ? { color: tone } : null]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}

// ─── Feedback ───

export function Banner({ message, tone = 'info' }: { message: string; tone?: 'info' | 'error' | 'warning' }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const color =
    tone === 'error' ? colors.statusError : tone === 'warning' ? colors.statusPermission : colors.textSecondary
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Text style={[styles.bannerText, { color }]}>{message}</Text>
    </View>
  )
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Text style={styles.emptyDetail}>{detail}</Text> : null}
    </View>
  )
}

export function Loading({ label }: { label?: string }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.textSecondary} />
      {label ? <Text style={styles.emptyDetail}>{label}</Text> : null}
    </View>
  )
}

// ─── Sheet ───

/**
 * A bottom sheet.
 *
 * Built on `Modal` rather than a gesture library because the app has no
 * animation dependency and adding one for this would be the largest thing in
 * the bundle. The scrim is a real `Pressable` covering the screen: an earlier
 * pattern put `onPress` on the container and let touches inside the panel
 * bubble to it, which dismissed the sheet whenever anyone scrolled its content.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  maxHeight = '80%',
}: {
  visible: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  maxHeight?: number | `${number}%`
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <SafeAreaView edges={['bottom']} style={[styles.sheet, { maxHeight }]}>
          <View style={styles.grabber} />
          {title ? (
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <View style={styles.grow} />
              <Pressable onPress={onClose} hitSlop={12}>
                <Text style={styles.sheetClose}>Done</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  )
}

/** One selectable row inside a {@link Sheet}. */
export function SheetRow({
  label,
  detail,
  selected,
  onPress,
  swatch,
}: {
  label: string
  detail?: string
  selected?: boolean
  onPress: () => void
  swatch?: string
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Pressable style={[styles.sheetRow, selected && styles.sheetRowActive]} onPress={onPress}>
      {swatch ? <View style={[styles.swatch, { backgroundColor: swatch }]} /> : null}
      <View style={styles.grow}>
        <Text style={[styles.sheetRowLabel, selected && styles.sheetRowLabelActive]} numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text style={styles.sheetRowDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    grow: { flex: 1 },

    section: { marginBottom: space.xl },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: space.sm },
    sectionTitle: {
      color: colors.textSecondary,
      fontSize: font.size.xs,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    hint: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: space.xs },
    mono: { fontFamily: font.mono },

    card: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
      gap: space.xs,
    },

    detailRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.xs },
    detailLabel: { color: colors.textTertiary, fontSize: font.size.sm, width: 108 },
    detailValue: { color: colors.textPrimary, fontSize: font.size.sm, flex: 1 },

    button: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingVertical: 13,
      paddingHorizontal: space.lg,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 46,
    },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonDanger: { borderColor: colors.statusError },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: colors.textSecondary, fontWeight: '600', fontSize: font.size.md },
    buttonTextPrimary: { color: colors.textOnAccent, fontWeight: '700' },
    buttonTextDanger: { color: colors.statusError },

    field: { marginBottom: space.md },
    fieldLabel: { color: colors.textSecondary, fontSize: font.size.sm, marginBottom: space.xs },
    input: {
      backgroundColor: colors.surfacePrimary,
      color: colors.textPrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      fontSize: font.size.sm,
    },
    inputMultiline: { minHeight: 96, textAlignVertical: 'top' },

    segment: {
      flexDirection: 'row',
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      overflow: 'hidden',
    },
    segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
    segmentItemActive: { backgroundColor: colors.accent },
    segmentText: { color: colors.textSecondary, fontSize: font.size.sm, textTransform: 'capitalize' },
    segmentTextActive: { color: colors.textOnAccent, fontWeight: '700' },

    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: space.sm,
    },
    toggleLabel: { color: colors.textPrimary, fontSize: font.size.md },
    switchTrack: {
      width: 46,
      height: 28,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceHover,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      justifyContent: 'center',
      padding: 2,
    },
    switchThumb: {
      width: 22,
      height: 22,
      borderRadius: radius.pill,
      backgroundColor: colors.textTertiary,
    },
    switchThumbOn: { alignSelf: 'flex-end', backgroundColor: colors.textOnAccent },

    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      backgroundColor: colors.surfacePrimary,
      maxWidth: 220,
    },
    chipActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
    chipText: { color: colors.textSecondary, fontSize: font.size.xs },
    chipTextActive: { color: colors.accent, fontWeight: '700' },

    banner: {
      borderWidth: 1,
      borderRadius: radius.md,
      padding: space.md,
      marginBottom: space.md,
      backgroundColor: colors.surfacePrimary,
    },
    bannerText: { fontSize: font.size.sm },

    empty: { alignItems: 'center', paddingVertical: space.xl, gap: space.xs },
    emptyTitle: { color: colors.textSecondary, fontSize: font.size.md, fontWeight: '600' },
    emptyDetail: {
      color: colors.textTertiary,
      fontSize: font.size.sm,
      textAlign: 'center',
      paddingHorizontal: space.xl,
    },
    loading: { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },

    sheetRoot: { flex: 1, justifyContent: 'flex-end' },
    // Not a palette token: the theme has no scrim colour, and a scrim is dark
    // in both light and dark mode — it darkens whatever is behind it rather
    // than participating in the palette.
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.45)' },
    sheet: {
      backgroundColor: colors.containerBgCollapsed,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: colors.containerBorder,
      ...elevation('popover'),
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.containerBorder,
      marginTop: space.sm,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.sm,
    },
    sheetTitle: { color: colors.textPrimary, fontSize: font.size.lg, fontWeight: '700' },
    sheetClose: { color: colors.accent, fontSize: font.size.md, fontWeight: '600' },
    sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.xs },

    sheetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: space.md,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    sheetRowActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
    sheetRowLabel: { color: colors.textPrimary, fontSize: font.size.md },
    sheetRowLabelActive: { color: colors.accent, fontWeight: '700' },
    sheetRowDetail: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: 2 },
    check: { color: colors.accent, fontSize: font.size.md, fontWeight: '700' },
    swatch: { width: 18, height: 18, borderRadius: radius.pill },
  })
