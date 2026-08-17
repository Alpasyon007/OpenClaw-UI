/**
 * Control Center — what the gateway is doing, and what it is configured as.
 *
 * Read-only. A phone is a good place to *see* that a node has dropped or that
 * a queue is backing up; it is a poor place to edit a runtime's configuration,
 * where a mistyped value in a text field on a train has consequences nobody can
 * see until later. Configuration is therefore rendered and not editable, and
 * the screen says so rather than leaving the reader to discover it by tapping.
 *
 * The admin half is hidden rather than disabled when the device lacks the
 * scope, with one line explaining the fix — a screen full of greyed-out cards
 * teaches nothing.
 */
import { useEffect, useMemo } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import type { ColorPalette } from '@openclaw/theme'
import { useColors, font, radius, space } from '../lib/theme'
import { useApp } from '../lib/store'
import { flattenPayload, nodeLabel, nodeOnline, useAdmin } from '../lib/admin'
import { Banner, Card, DetailRow, EmptyState, Loading, Section } from '../components/ui'

export default function ControlCenterScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const conn = useApp((s) => s.conn)
  const serverVersion = useApp((s) => s.serverVersion)
  const scopes = useApp((s) => s.scopes)
  const { health, status, nodes, config, loading, adminBlocked, errors, refresh, hasAdmin } =
    useAdmin()

  useEffect(() => {
    if (conn === 'ready') void refresh()
  }, [conn, refresh])

  const admin = hasAdmin()

  const healthRows = useMemo(() => flattenPayload(health), [health])
  const statusRows = useMemo(() => flattenPayload(status), [status])
  const configRows = useMemo(() => flattenPayload(config), [config])

  if (conn !== 'ready') {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Stack.Screen options={{ title: 'Control Center' }} />
        <EmptyState
          title="Not connected"
          detail="Connect to a gateway from Settings to see its health and nodes."
        />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Control Center' }} />
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
            tintColor={colors.textSecondary}
          />
        }
      >
        {adminBlocked ? <Banner tone="warning" message={adminBlocked} /> : null}

        <Section title="Gateway">
          <Card>
            <DetailRow label="Version" value={serverVersion ?? 'unknown'} />
            <DetailRow label="Scopes" value={scopes.join(', ') || '(none)'} mono />
          </Card>
        </Section>

        <Section
          title={`Nodes (${nodes.length})`}
          hint={errors.nodes ? undefined : 'Hosts this gateway can route work to.'}
        >
          {errors.nodes ? (
            <Banner tone="error" message={errors.nodes} />
          ) : nodes.length === 0 ? (
            <Card>
              <Text style={styles.quiet}>No nodes reported.</Text>
            </Card>
          ) : (
            nodes.map((node, index) => (
              <View key={node.id ?? node.nodeId ?? `${nodeLabel(node)}:${index}`} style={styles.node}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: nodeOnline(node) ? colors.statusComplete : colors.statusIdle },
                  ]}
                />
                <View style={styles.grow}>
                  <Text style={styles.nodeName} numberOfLines={1}>
                    {nodeLabel(node)}
                  </Text>
                  <Text style={styles.nodeMeta} numberOfLines={1}>
                    {[node.platform, node.version, node.status].filter(Boolean).join(' · ') ||
                      'no detail reported'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </Section>

        <PayloadSection
          title="Health"
          rows={healthRows}
          error={errors.health}
          styles={styles}
        />

        <PayloadSection
          title="Status"
          rows={statusRows}
          error={errors.status}
          styles={styles}
        />

        {admin ? (
          <PayloadSection
            title="Configuration"
            rows={configRows}
            error={errors.config}
            styles={styles}
            hint="Read-only here. Edit configuration from the desktop app or the CLI."
          />
        ) : null}

        {loading && !health && !status ? <Loading label="Asking the gateway…" /> : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function PayloadSection({
  title,
  rows,
  error,
  styles,
  hint,
}: {
  title: string
  rows: Array<{ label: string; value: string }>
  error?: string
  styles: ReturnType<typeof makeStyles>
  hint?: string
}) {
  if (error) {
    return (
      <Section title={title}>
        <Banner tone="error" message={error} />
      </Section>
    )
  }

  if (rows.length === 0) {
    return (
      <Section title={title} hint={hint}>
        <Card>
          <Text style={styles.quiet}>Nothing reported.</Text>
        </Card>
      </Section>
    )
  }

  return (
    <Section title={title} hint={hint}>
      <Card>
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} mono />
        ))}
      </Card>
    </Section>
  )
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.containerBg },
    container: { padding: space.lg },
    grow: { flex: 1 },
    quiet: { color: colors.textTertiary, fontSize: font.size.sm },
    node: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      backgroundColor: colors.surfacePrimary,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.containerBorder,
      padding: space.md,
      marginBottom: space.sm,
    },
    dot: { width: 10, height: 10, borderRadius: radius.pill },
    nodeName: { color: colors.textPrimary, fontSize: font.size.md, fontWeight: '600' },
    nodeMeta: { color: colors.textTertiary, fontSize: font.size.xs, marginTop: 2 },
  })
