/**
 * Attachments on an outbound message.
 *
 * The wire shape mirrors the content-block form the agent runtime already
 * consumes — `{ type, source: { type: 'base64', media_type, data } }` — rather
 * than inventing a flat `{name, bytes}` envelope, because the gateway forwards
 * these into a provider request and a shape it has to rewrite is a shape it can
 * get wrong. `name` and `sizeBytes` ride alongside as metadata the UI needs and
 * the provider ignores.
 *
 * The hard constraint here is size, and it is not advisory: the gateway closes
 * the socket outright when a frame exceeds its payload cap, so a client that
 * sends an oversized attachment does not get a rejection — it gets a dropped
 * connection mid-conversation and no explanation. {@link fitsPayloadBudget} is
 * how a caller checks *before* writing to the socket.
 */
import { z } from 'zod'
import { MAX_PAYLOAD_BYTES } from './frames'

/** Image types worth sending to a vision model. */
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

export const AttachmentSourceSchema = z.object({
  type: z.literal('base64'),
  media_type: z.string().min(1),
  data: z.string().min(1),
})

export const ChatAttachmentSchema = z.object({
  /**
   * `image` is rendered by the model directly; `document` is carried as text or
   * as a file part depending on what the runtime supports. Anything the phone
   * cannot classify is sent as `document` rather than guessed at.
   */
  type: z.enum(['image', 'document']),
  source: AttachmentSourceSchema,
  /** Original filename. Display only — never used as a path by anything. */
  name: z.string().optional(),
  /** Decoded size. Present so a UI can show it without decoding the payload. */
  sizeBytes: z.number().int().nonnegative().optional(),
})

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>

/**
 * Base64 inflates by 4/3, plus up to two padding characters.
 *
 * Worth computing rather than eyeballing: a 20 MB photo is under a 25 MB cap
 * as bytes and 27 MB once encoded, so a check against the raw file size passes
 * and the send still kills the socket.
 */
export function encodedSize(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

/**
 * Whether a set of attachments plus a message body fits the frame budget.
 *
 * `limit` should come from `hello-ok.policy.maxPayload` when the gateway sent
 * one; {@link MAX_PAYLOAD_BYTES} is the documented default and only a fallback.
 * A margin is held back for the JSON envelope, the session key and the
 * idempotency key — being right at the boundary is the same failure as being
 * over it.
 */
export const PAYLOAD_MARGIN_BYTES = 64 * 1024

export function fitsPayloadBudget(
  attachments: readonly ChatAttachment[],
  messageBytes: number,
  limit: number = MAX_PAYLOAD_BYTES,
): { ok: true } | { ok: false; totalBytes: number; limitBytes: number } {
  const total =
    messageBytes +
    attachments.reduce((sum, a) => sum + a.source.data.length, 0) +
    PAYLOAD_MARGIN_BYTES

  const budget = Math.max(0, limit)
  return total <= budget ? { ok: true } : { ok: false, totalBytes: total, limitBytes: budget }
}

/** Classify a MIME type into the two shapes the wire format distinguishes. */
export function attachmentKindFor(mimeType: string): 'image' | 'document' {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase())
    ? 'image'
    : 'document'
}

/**
 * Human-readable size.
 *
 * Binary units because the payload cap is expressed in them; showing "26.2 MB"
 * next to a "25 MB limit" the file actually exceeds is the kind of off-by-1024
 * that makes a correct error look like a bug.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
