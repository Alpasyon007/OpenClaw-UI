/**
 * Tool approval.
 *
 * This is the screen that justifies the app, and it is also the one place where
 * a mistake executes a command on the user's machine. Three rules:
 *
 *  - The command is rendered as **inert text**. Transcript and tool content is
 *    untrusted — the gateway itself wraps fetched material in
 *    EXTERNAL_UNTRUSTED_CONTENT markers — so nothing here is interpreted.
 *  - Sensitive-looking values are masked, matching the desktop's PermissionCard.
 *  - Only the decisions the request actually permits are offered. Showing
 *    `allow-always` when policy forbids durable trust promises something the
 *    gateway will refuse.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { availableDecisions, type ApprovalDecision, type ExecApprovalRequested } from '@openclaw/protocol'
import { colors, font, radius, space } from '../lib/theme'

const SENSITIVE = /token|password|secret|key|auth|credential|api.?key/i

/** Mask values whose *name* suggests a credential, as the desktop card does. */
function maskLine(line: string): string {
  return line.replace(
    /([A-Za-z0-9_.-]*(?:token|password|secret|key|auth|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(\S+)/gi,
    (_m, name: string, sep: string) => `${name}${sep}••••••••`,
  )
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  'allow-once': 'Allow once',
  'allow-always': 'Always allow',
  deny: 'Deny',
}

export function ApprovalSheet({
  approval,
  onResolve,
}: {
  approval: ExecApprovalRequested | null
  onResolve: (id: string, decision: ApprovalDecision) => void
}) {
  if (!approval) return null

  const req = approval.request
  const command = maskLine(req.command ?? req.commandArgv?.join(' ') ?? '(no command reported)')
  const decisions = availableDecisions(req)

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => onResolve(approval.id, 'deny')}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Approve this command?</Text>
          <Text style={styles.subtitle}>
            {req.host ? `on ${req.host}` : 'on the agent host'}
            {req.nodeId ? ` · ${req.nodeId}` : ''}
          </Text>

          {req.warningText ? (
            <View style={styles.warning}>
              <Text style={styles.warningText}>{req.warningText}</Text>
            </View>
          ) : null}

          <ScrollView style={styles.commandBox} contentContainerStyle={{ padding: space.md }}>
            <Text style={styles.command} selectable>
              {command}
            </Text>
          </ScrollView>

          <View style={styles.meta}>
            {req.cwd ? <MetaRow label="cwd" value={req.cwd} /> : null}
            {req.security ? <MetaRow label="security" value={req.security} /> : null}
            {req.sessionKey ? <MetaRow label="session" value={req.sessionKey} /> : null}
          </View>

          <View style={styles.actions}>
            {decisions.map((d) => (
              <Pressable
                key={d}
                style={[styles.button, d === 'deny' ? styles.deny : styles.allow]}
                onPress={() => onResolve(approval.id, d)}
              >
                <Text style={[styles.buttonText, d === 'deny' ? styles.denyText : styles.allowText]}>
                  {DECISION_LABEL[d]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  const shown = SENSITIVE.test(label) ? '••••••••' : value
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2}>
        {shown}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000cc', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    borderTopWidth: 1,
    borderColor: colors.borderStrong,
    maxHeight: '85%',
  },
  title: { color: colors.text, fontSize: font.size.xl, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: font.size.sm, marginTop: space.xs },
  warning: {
    backgroundColor: '#3a2a0a',
    borderRadius: radius.sm,
    padding: space.md,
    marginTop: space.md,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  warningText: { color: colors.warn, fontSize: font.size.sm },
  commandBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: space.md,
    maxHeight: 200,
  },
  command: { color: colors.text, fontFamily: font.mono, fontSize: font.size.sm },
  meta: { marginTop: space.md, gap: space.xs },
  metaRow: { flexDirection: 'row', gap: space.sm },
  metaLabel: { color: colors.textFaint, fontSize: font.size.xs, width: 64 },
  metaValue: { color: colors.textMuted, fontSize: font.size.xs, flex: 1, fontFamily: font.mono },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  button: { flex: 1, paddingVertical: 14, borderRadius: radius.sm, alignItems: 'center' },
  allow: { backgroundColor: colors.accent },
  deny: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.error },
  buttonText: { fontWeight: '700', fontSize: font.size.md },
  allowText: { color: colors.accentText },
  denyText: { color: colors.error },
})
