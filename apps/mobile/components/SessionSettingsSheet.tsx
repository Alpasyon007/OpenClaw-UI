/**
 * Per-session settings: model, agent, approval policy.
 *
 * Everything here is scoped to one session key and persists across app
 * restarts, because the alternative — asking again every time a conversation is
 * reopened — is how a user ends up sending to the wrong model without noticing.
 *
 * "Gateway default" is a real, selectable option rather than the absence of a
 * choice. Without it there is no way back once a model has been picked, and
 * clearing a field by selecting nothing is not a gesture that exists on a
 * phone.
 */
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { ColorPalette } from '@openclaw/theme'
import { estimateCost, formatCost, formatTokens, tokenTotals } from '@openclaw/conversation'
import { useColors, font, space } from '../lib/theme'
import { useApp } from '../lib/store'
import { usePrefs, PERMISSION_MODES, type PermissionMode } from '../lib/prefs'
import { Banner, Section, Segmented, Sheet, SheetRow } from './ui'

type Tab = 'model' | 'agent' | 'permissions' | 'cost'

interface Props {
  sessionKey: string
  visible: boolean
  tab: Tab
  onClose: () => void
}

export function SessionSettingsSheet({ sessionKey, visible, tab, onClose }: Props) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const models = useApp((s) => s.models)
  const agents = useApp((s) => s.agents)
  const meta = useApp((s) => s.sessionMeta[sessionKey])
  const usage = useApp((s) => s.transcripts[sessionKey]?.usage ?? null)

  const prefs = usePrefs((s) => s.sessions[sessionKey])
  const setSessionPrefs = usePrefs((s) => s.setSessionPrefs)

  const title =
    tab === 'model'
      ? 'Model'
      : tab === 'agent'
        ? 'Agent'
        : tab === 'permissions'
          ? 'Tool approvals'
          : 'Usage'

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {tab === 'model' ? (
        <ModelList
          models={models}
          selected={prefs?.model}
          sessionModel={meta?.model ?? null}
          onSelect={(model) => {
            setSessionPrefs(sessionKey, { model })
            onClose()
          }}
        />
      ) : null}

      {tab === 'agent' ? (
        <AgentList
          agents={agents}
          selected={prefs?.agentId}
          onSelect={(agentId) => {
            setSessionPrefs(sessionKey, { agentId })
            onClose()
          }}
        />
      ) : null}

      {tab === 'permissions' ? (
        <PermissionPicker
          value={prefs?.permissionMode ?? 'ask'}
          onChange={(permissionMode) => setSessionPrefs(sessionKey, { permissionMode })}
          styles={styles}
        />
      ) : null}

      {tab === 'cost' ? (
        <UsageDetail
          usage={usage}
          model={prefs?.model ?? meta?.model ?? null}
          styles={styles}
        />
      ) : null}
    </Sheet>
  )
}

function ModelList({
  models,
  selected,
  sessionModel,
  onSelect,
}: {
  models: { id: string; label?: string }[]
  selected?: string
  sessionModel: string | null
  onSelect: (model: string | undefined) => void
}) {
  return (
    <>
      <SheetRow
        label="Gateway default"
        detail={sessionModel ? `Currently ${sessionModel}` : 'Whatever the session already uses'}
        selected={!selected}
        onPress={() => onSelect(undefined)}
      />
      {models.length === 0 ? (
        <Banner message="This gateway did not report any models. `models.list` returned nothing." />
      ) : null}
      {models.map((model) => (
        <SheetRow
          key={model.id}
          label={model.label ?? model.id}
          detail={model.label ? model.id : undefined}
          selected={selected === model.id}
          onPress={() => onSelect(model.id)}
        />
      ))}
    </>
  )
}

function AgentList({
  agents,
  selected,
  onSelect,
}: {
  agents: { id: string; name?: string }[]
  selected?: string
  onSelect: (agentId: string | undefined) => void
}) {
  return (
    <>
      <SheetRow
        label="Gateway default"
        detail="Route to whichever agent owns the session"
        selected={!selected}
        onPress={() => onSelect(undefined)}
      />
      {agents.length === 0 ? (
        <Banner message="This gateway did not report any agents." />
      ) : null}
      {agents.map((agent) => (
        <SheetRow
          key={agent.id}
          label={agent.name ?? agent.id}
          detail={agent.name ? agent.id : undefined}
          selected={selected === agent.id}
          onPress={() => onSelect(agent.id)}
        />
      ))}
    </>
  )
}

function PermissionPicker({
  value,
  onChange,
  styles,
}: {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={styles.block}>
      <Segmented
        options={PERMISSION_MODES}
        value={value}
        onChange={onChange}
        labels={{ ask: 'Ask me', auto: 'Auto-approve' }}
      />
      {value === 'auto' ? (
        // Stated at full strength, every time, for as long as it is on. This
        // approves shell commands on the gateway host with nobody reading them,
        // and a one-line hint the user scrolled past a week ago is not informed
        // consent.
        <Banner
          tone="warning"
          message={
            'Every tool request from this session is approved automatically, without showing you the command. ' +
            'The gateway’s own policy is the only remaining check. This applies to this session only and is not ' +
            'carried to new ones.'
          }
        />
      ) : (
        <Text style={styles.hint}>
          Tool requests from this session open an approval sheet and wait for you.
        </Text>
      )}
    </View>
  )
}

function UsageDetail({
  usage,
  model,
  styles,
}: {
  usage: Record<string, number> | null
  model: string | null
  styles: ReturnType<typeof makeStyles>
}) {
  const totals = useMemo(() => tokenTotals(usage), [usage])
  const cost = formatCost(estimateCost(totals, model))

  if (totals.total === 0) {
    return <Text style={styles.hint}>No usage reported for this session yet.</Text>
  }

  return (
    <View style={styles.block}>
      <Section title="Tokens">
        <UsageRow label="Input" value={formatTokens(totals.input)} styles={styles} />
        <UsageRow label="Output" value={formatTokens(totals.output)} styles={styles} />
        <UsageRow label="Cache read" value={formatTokens(totals.cacheRead)} styles={styles} />
        <UsageRow label="Cache write" value={formatTokens(totals.cacheWrite)} styles={styles} />
        <UsageRow label="Total" value={formatTokens(totals.total)} styles={styles} strong />
      </Section>

      {cost ? (
        <Section title="Estimated cost">
          <Text style={styles.cost}>{cost}</Text>
          <Text style={styles.hint}>
            Estimated from published list prices for {model}. Negotiated rates, batch pricing and
            non-Anthropic providers will differ.
          </Text>
        </Section>
      ) : (
        // No rate table entry. Showing "$0.00" here would read as "this was
        // free", which is the one wrong answer.
        <Text style={styles.hint}>
          No published rate is known for {model ?? 'this model'}, so no cost is estimated.
        </Text>
      )}
    </View>
  )
}

function UsageRow({
  label,
  value,
  styles,
  strong,
}: {
  label: string
  value: string
  styles: ReturnType<typeof makeStyles>
  strong?: boolean
}) {
  return (
    <View style={styles.usageRow}>
      <Text style={[styles.usageLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.usageValue, strong && styles.strong]}>{value}</Text>
    </View>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    block: { gap: space.md, paddingTop: space.sm },
    hint: { color: colors.textTertiary, fontSize: font.size.xs, lineHeight: 16 },
    usageRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
    usageLabel: { color: colors.textSecondary, fontSize: font.size.sm },
    usageValue: { color: colors.textPrimary, fontSize: font.size.sm, fontFamily: font.mono },
    strong: { color: colors.textPrimary, fontWeight: '700' },
    cost: { color: colors.accent, fontSize: font.size.xl, fontWeight: '700' },
  })
