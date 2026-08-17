/**
 * Getting a transcript off the phone.
 *
 * Two routes, because neither one covers everything:
 *
 *  - **Share a file.** `expo-sharing` hands other apps a real `.md` through the
 *    platform's file provider. This is the one that produces a document rather
 *    than a wall of text, and it is the default.
 *  - **Copy to the clipboard.** The fallback, and the only thing that works
 *    when no app on the device declares itself able to receive a markdown file
 *    — which is a surprisingly common state on a clean Android install.
 *
 * React Native's own `Share` is deliberately not used for the file: its `url`
 * field is iOS-only, so on Android it silently degrades to sharing the file
 * *path* as text, which looks like it worked and delivers nothing.
 */
import * as Clipboard from 'expo-clipboard'
import * as Sharing from 'expo-sharing'
import { exportFilename, toMarkdown, type ExportOptions } from '@openclaw/conversation'
import type { TranscriptMessage } from '@openclaw/conversation'
import { cacheFile } from './storage'

export type ExportOutcome =
  | { ok: true; via: 'share' | 'clipboard' }
  | { ok: false; error: string }

/**
 * Write the transcript to a cache file and open the share sheet.
 *
 * Falls back to the clipboard when nothing on the device can receive the file,
 * and says which of the two happened so the caller can tell the user where
 * their export went.
 */
export async function shareTranscript(
  messages: readonly TranscriptMessage[],
  options: ExportOptions,
): Promise<ExportOutcome> {
  const now = options.now ?? Date.now()
  const markdown = toMarkdown(messages, { ...options, now })

  try {
    if (await Sharing.isAvailableAsync()) {
      const file = cacheFile(exportFilename(options.sessionKey, now))
      if (!file.exists) file.create({ overwrite: true, intermediates: true })
      file.write(markdown)

      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/markdown',
        dialogTitle: 'Export conversation',
        UTI: 'net.daringfireball.markdown',
      })
      return { ok: true, via: 'share' }
    }
  } catch (err) {
    // A share that fails still has a perfectly good markdown string in hand;
    // dropping to the clipboard is better than reporting a failure and
    // discarding the work.
    const failure = describe(err)
    const copied = await copyToClipboard(markdown)
    return copied.ok ? { ok: true, via: 'clipboard' } : { ok: false, error: failure }
  }

  const copied = await copyToClipboard(markdown)
  return copied.ok ? { ok: true, via: 'clipboard' } : copied
}

/** Copy the transcript as markdown, with no share sheet. */
export async function copyTranscript(
  messages: readonly TranscriptMessage[],
  options: ExportOptions,
): Promise<ExportOutcome> {
  return copyToClipboard(toMarkdown(messages, options))
}

async function copyToClipboard(text: string): Promise<ExportOutcome> {
  try {
    await Clipboard.setStringAsync(text)
    return { ok: true, via: 'clipboard' }
  } catch (err) {
    return { ok: false, error: describe(err) }
  }
}

/** Share arbitrary text — used by the theme and skill editors for their JSON. */
export async function shareText(
  text: string,
  filename: string,
  mimeType: string,
): Promise<ExportOutcome> {
  try {
    if (await Sharing.isAvailableAsync()) {
      const file = cacheFile(filename)
      if (!file.exists) file.create({ overwrite: true, intermediates: true })
      file.write(text)
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename })
      return { ok: true, via: 'share' }
    }
  } catch {
    // As above — fall through to the clipboard.
  }
  return copyToClipboard(text)
}

/** Read the clipboard, for importing a theme or a skill someone sent over. */
export async function readClipboard(): Promise<string> {
  try {
    return await Clipboard.getStringAsync()
  } catch {
    return ''
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
