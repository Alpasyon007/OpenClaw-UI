/**
 * Skill Builder — write a `SKILL.md` and put it on the gateway.
 *
 * The form is deliberately four fields and a body. A skill is a name, a
 * description that decides when it triggers, and instructions; everything else
 * a runtime supports is optional and can be added by editing the file later.
 *
 * Installing needs `operator.admin`, which most companion devices do not have.
 * That does not make this screen useless: the rendered file can be exported or
 * copied, which is the actual workflow for anyone who authors on a phone and
 * installs from a desktop. The install button explains its absence rather than
 * sitting greyed out.
 */
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import {
  SKILL_TEMPLATE,
  renderSkillMd,
  toSkillName,
  validateSkill,
  type SkillDraft,
} from '@openclaw/marketplace'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, font, radius, space } from '../lib/theme'
import { useMarketplace } from '../lib/marketplace'
import { shareText } from '../lib/share'
import { Banner, Button, Field, Section } from '../components/ui'

export default function SkillBuilderScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const installBlocked = useMarketplace((s) => s.installBlocked)
  const installRaw = useMarketplace((s) => s.installRaw)
  const refreshInventory = useMarketplace((s) => s.refreshInventory)

  const [draft, setDraft] = useState<SkillDraft>({
    name: '',
    description: '',
    instructions: SKILL_TEMPLATE,
    emoji: '',
  })
  const [notice, setNotice] = useState('')
  const [tone, setTone] = useState<'info' | 'error'>('info')
  const [busy, setBusy] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const validation = useMemo(() => validateSkill(draft), [draft])
  const rendered = useMemo(() => renderSkillMd(draft), [draft])

  const say = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    setTone(kind)
    setNotice(message)
  }, [])

  const onInstall = useCallback(async () => {
    if (!validation.ok) {
      say(validation.errors[0], 'error')
      return
    }
    setBusy(true)
    const outcome = await installRaw(draft.name, rendered)
    setBusy(false)

    if (!outcome.ok) {
      say(outcome.error ?? 'Install failed.', 'error')
      return
    }
    void refreshInventory()
    say(`Installed “${draft.name}” on the gateway.`)
  }, [validation, draft.name, rendered, installRaw, refreshInventory, say])

  const onExport = useCallback(async () => {
    if (!draft.name.trim()) {
      say('Give the skill a name first — it becomes the filename.', 'error')
      return
    }
    const outcome = await shareText(rendered, `${draft.name}-SKILL.md`, 'text/markdown')
    if (!outcome.ok) say(outcome.error, 'error')
    else say(outcome.via === 'clipboard' ? 'Copied to the clipboard.' : 'Exported.')
  }, [draft.name, rendered, say])

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'New skill' }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {notice ? <Banner message={notice} tone={tone} /> : null}
        {installBlocked ? <Banner tone="warning" message={installBlocked} /> : null}

        <Section title="Identity">
          <Field
            label="Name"
            value={draft.name}
            // Coerced as it is typed, so the box always shows what will be
            // installed. Accepting "My Skill" and quietly writing `my-skill`
            // leaves the author unable to find it afterwards.
            onChangeText={(name) => setDraft((d) => ({ ...d, name: toSkillName(name) }))}
            placeholder="pdf-review"
            autoCapitalize="none"
            autoCorrect={false}
            hint="Lowercase, hyphens. This becomes the directory the skill installs to."
          />
          <Field
            label="Emoji (optional)"
            value={draft.emoji}
            onChangeText={(emoji) => setDraft((d) => ({ ...d, emoji }))}
            placeholder="📄"
            maxLength={4}
          />
        </Section>

        <Section title="Description">
          <Field
            value={draft.description}
            onChangeText={(description) => setDraft((d) => ({ ...d, description }))}
            placeholder="Use when the user asks to review a PDF for tone, structure and factual claims."
            multiline
            hint="The model reads this to decide whether to use the skill. Say when it applies, not just what it is."
          />
        </Section>

        <Section title="Instructions">
          <Field
            value={draft.instructions}
            onChangeText={(instructions) => setDraft((d) => ({ ...d, instructions }))}
            multiline
            style={styles.body}
          />
        </Section>

        {validation.warnings.length > 0 ? (
          <Banner tone="warning" message={validation.warnings.join(' ')} />
        ) : null}
        {validation.errors.length > 0 ? (
          <Text style={styles.errors}>{validation.errors.join('\n')}</Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            label="Install"
            variant="primary"
            busy={busy}
            disabled={!validation.ok || !!installBlocked}
            onPress={() => void onInstall()}
            style={styles.action}
          />
          <Button label="Export" onPress={() => void onExport()} style={styles.action} />
        </View>

        <Section title="SKILL.md">
          <Button
            label={showPreview ? 'Hide preview' : 'Show preview'}
            onPress={() => setShowPreview((v) => !v)}
          />
          {showPreview ? (
            <View style={styles.preview}>
              <Text style={styles.previewText} selectable>
                {rendered}
              </Text>
            </View>
          ) : null}
        </Section>

        <Button label="Back to skills" onPress={() => router.replace('/marketplace')} />
      </ScrollView>
    </SafeAreaView>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg, paddingBottom: space.xl * 2 },
    body: { minHeight: 200 },
    errors: { color: colors.statusError, fontSize: font.size.xs, marginBottom: space.md },
    actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.xl },
    action: { flex: 1 },
    preview: {
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
      marginTop: space.sm,
    },
    previewText: { color: colors.textSecondary, fontFamily: font.mono, fontSize: font.size.xs },
  })
