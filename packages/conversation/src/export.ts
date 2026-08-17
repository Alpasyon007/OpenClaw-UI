/**
 * Transcript → a file someone can read later.
 *
 * Pure string building, kept out of the screen component so the format is
 * testable and identical wherever it is offered.
 *
 * The one judgement call worth naming: **assistant text is emitted verbatim,
 * user text is fenced.** Assistant output is already markdown and re-escaping
 * it would wreck every table and code block in the export. User text is not —
 * it is whatever someone typed into a phone keyboard, and a stray backtick or
 * leading `#` there would silently restyle their own words in the output. The
 * asymmetry is deliberate and mirrors how the two are rendered on screen.
 */
import type { TranscriptMessage } from './transcript'
import { formatCost, formatTokens, estimateCost, tokenTotals } from './usage'

export interface ExportOptions {
  /** Session key, used for the heading and the filename. */
  sessionKey: string
  /** Friendly title, when the gateway supplied one. */
  title?: string | null
  /** What the assistant is called, from the active theme's branding. */
  assistantName?: string
  /** Model id, so the cost line can be priced. */
  model?: string | null
  usage?: Record<string, number> | null
  /** Injected rather than read from the clock, so exports are reproducible. */
  now?: number
  /** Tool rows are activity, not conversation; off by default. */
  includeTools?: boolean
}

/**
 * A filename that survives every filesystem and share sheet it might meet.
 *
 * Session keys contain colons (`agent:main:clui-…`), which are a path separator
 * on one major platform and illegal in a filename on another. Everything
 * outside a conservative safe set is collapsed to a hyphen rather than stripped,
 * so two keys differing only in punctuation do not produce the same filename.
 */
export function exportFilename(sessionKey: string, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const slug =
    sessionKey
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'session'
  return `openclaw-${slug}-${stamp}.md`
}

/** A transcript as a self-contained markdown document. */
export function toMarkdown(
  messages: readonly TranscriptMessage[],
  options: ExportOptions,
): string {
  const now = options.now ?? Date.now()
  const assistant = options.assistantName?.trim() || 'Assistant'
  const lines: string[] = []

  lines.push(`# ${options.title?.trim() || options.sessionKey}`)
  lines.push('')
  lines.push(`- Session: \`${options.sessionKey}\``)
  lines.push(`- Exported: ${new Date(now).toISOString()}`)
  if (options.model) lines.push(`- Model: \`${options.model}\``)

  const totals = tokenTotals(options.usage)
  if (totals.total > 0) {
    const cost = formatCost(estimateCost(totals, options.model))
    // "estimated" is not hedging for its own sake — the rate table cannot know
    // about negotiated pricing, and an export is the copy most likely to be
    // pasted somewhere it will be read as authoritative.
    lines.push(
      `- Tokens: ${formatTokens(totals.total)}${cost ? ` (estimated ${cost})` : ''}`,
    )
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const message of messages) {
    if (message.role === 'tool') {
      if (!options.includeTools) continue
      lines.push(`### ⚙ ${message.toolName ?? 'tool'}`)
      if (message.content) {
        lines.push('')
        lines.push('```')
        lines.push(fenceSafe(message.content))
        lines.push('```')
      }
      lines.push('')
      continue
    }

    if (!message.content.trim()) continue

    if (message.role === 'user') {
      lines.push('### You')
      lines.push('')
      // Fenced, per the module note: this is untrusted-as-markdown text.
      lines.push('```text')
      lines.push(fenceSafe(message.content))
      lines.push('```')
    } else {
      lines.push(`### ${message.role === 'assistant' ? assistant : 'System'}`)
      lines.push('')
      lines.push(message.content)
    }

    if (message.status === 'error') lines.push('', '> This message ended in an error.')
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Neutralise a closing fence inside fenced content.
 *
 * Without this, a user message containing ``` ends the block early and the rest
 * of the transcript renders as markdown — which is precisely the injection the
 * fencing was there to prevent.
 */
function fenceSafe(text: string): string {
  return text.replace(/```/g, '`​``')
}

/** The same transcript with no markup, for pasting into a plain-text field. */
export function toPlainText(
  messages: readonly TranscriptMessage[],
  options: ExportOptions,
): string {
  const assistant = options.assistantName?.trim() || 'Assistant'
  const out: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!options.includeTools) continue
      out.push(`[${message.toolName ?? 'tool'}] ${message.content}`.trim())
      continue
    }
    if (!message.content.trim()) continue
    out.push(`${message.role === 'user' ? 'You' : assistant}: ${message.content}`)
  }
  return out.join('\n\n')
}
