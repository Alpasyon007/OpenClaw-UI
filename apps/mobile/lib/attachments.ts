/**
 * Picking files and turning them into wire attachments.
 *
 * Everything here funnels into {@link ChatAttachment}, which carries base64.
 * That has a consequence worth stating plainly: **the whole file goes into one
 * WebSocket frame.** The gateway closes the connection outright when a frame
 * exceeds its payload cap rather than replying with an error, so a phone photo
 * — routinely 5–15 MB, and a third larger again once encoded — is not something
 * to send optimistically and apologise for afterwards. Images are downscaled at
 * pick time, and the composer size-checks the set before it goes near the
 * socket.
 *
 * Nothing here writes to the document directory. Picked files are read into
 * memory and held only while they sit in the composer.
 */
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { File } from 'expo-file-system'
import {
  attachmentKindFor,
  encodedSize,
  formatBytes,
  type ChatAttachment,
} from '@openclaw/protocol'
import { brandingNow } from './theme'

/** A picked file as the composer holds it, before it is sent. */
export interface DraftAttachment {
  /** Local-only id, for keying the chip row and removing one. */
  id: string
  name: string
  mimeType: string
  /** Decoded size in bytes. */
  sizeBytes: number
  /** Base64 payload, with no data-URI prefix. */
  data: string
  /** Present for images, so the chip can show a thumbnail. */
  previewUri?: string
}

export type PickOutcome =
  | { ok: true; attachments: DraftAttachment[] }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'denied'; message: string }
  | { ok: false; reason: 'failed'; message: string }

/**
 * Longest edge, in pixels, an attached image is reduced to.
 *
 * 1568 is not arbitrary: it is the point above which vision models downscale
 * the image themselves, so pixels beyond it cost payload and tokens and buy
 * nothing at all. Doing it here also turns a 12 MB camera JPEG into a few
 * hundred kilobytes, which is the difference between an attachment that sends
 * and one that drops the connection.
 */
export const MAX_IMAGE_EDGE = 1568

/** JPEG quality for the re-encode. Below this, screenshots of text smear. */
export const IMAGE_QUALITY = 0.8

let counter = 0
const nextId = (): string => `att:${Date.now()}:${counter++}`

/**
 * Pick images from the library.
 *
 * Permission is requested rather than assumed, and a refusal is reported as
 * one — a picker that opens onto nothing with no explanation is the most common
 * way this fails silently.
 */
export async function pickImages(): Promise<PickOutcome> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      return {
        ok: false,
        reason: 'denied',
        message: `Photo access is off for ${brandingNow().appName}. Turn it on in Android settings to attach images.`,
      }
    }

    // `base64: false` deliberately: the manipulator re-encodes below, and
    // asking the picker for base64 as well doubles peak memory for a payload
    // that is thrown away.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 1,
      base64: false,
    })

    if (result.canceled) return { ok: false, reason: 'cancelled' }
    return { ok: true, attachments: await prepareImages(result.assets) }
  } catch (err) {
    return { ok: false, reason: 'failed', message: describe(err) }
  }
}

/** Take a photo and attach it. */
export async function captureImage(): Promise<PickOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) {
      return {
        ok: false,
        reason: 'denied',
        message: `Camera access is off for ${brandingNow().appName}. Turn it on in Android settings to take a photo.`,
      }
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 1, base64: false })
    if (result.canceled) return { ok: false, reason: 'cancelled' }
    return { ok: true, attachments: await prepareImages(result.assets) }
  } catch (err) {
    return { ok: false, reason: 'failed', message: describe(err) }
  }
}

/**
 * Downscale and encode picked images.
 *
 * One asset failing does not fail the batch — a single cloud photo that never
 * finished downloading should not discard the four that picked fine alongside
 * it.
 */
async function prepareImages(
  assets: readonly ImagePicker.ImagePickerAsset[],
): Promise<DraftAttachment[]> {
  const out: DraftAttachment[] = []
  for (const asset of assets) {
    try {
      out.push(await prepareImage(asset))
    } catch {
      // Skipped rather than surfaced: the chip row shows what made it, and a
      // per-asset error dialog for a five-photo selection is worse than the
      // omission it reports.
    }
  }
  return out
}

async function prepareImage(asset: ImagePicker.ImagePickerAsset): Promise<DraftAttachment> {
  const sourceMime = asset.mimeType || guessImageMime(asset.uri)
  // PNG is preserved rather than converted: PNG attachments are overwhelmingly
  // screenshots of text, and JPEG artefacts on text are exactly the thing that
  // makes a model misread a stack trace.
  const keepPng = sourceMime === 'image/png'
  const format = keepPng ? SaveFormat.PNG : SaveFormat.JPEG
  const outMime = keepPng ? 'image/png' : 'image/jpeg'

  const longest = Math.max(asset.width ?? 0, asset.height ?? 0)
  const context = ImageManipulator.manipulate(asset.uri)
  if (longest > MAX_IMAGE_EDGE) {
    // Only the long edge is given; the manipulator derives the other and the
    // aspect ratio is preserved. Passing both would letterbox non-standard
    // aspect ratios.
    const portrait = (asset.height ?? 0) >= (asset.width ?? 0)
    context.resize(portrait ? { height: MAX_IMAGE_EDGE } : { width: MAX_IMAGE_EDGE })
  }

  const rendered = await context.renderAsync()
  const saved = await rendered.saveAsync({
    base64: true,
    compress: keepPng ? 1 : IMAGE_QUALITY,
    format,
  })

  const data = saved.base64 ?? ''
  if (!data) throw new Error('image encoded to an empty payload')

  return {
    id: nextId(),
    name: asset.fileName || `image${extensionFor(outMime)}`,
    mimeType: outMime,
    // Derived from the encoded payload rather than taken from the asset: the
    // asset's `fileSize` describes the original, and after a downscale that is
    // wrong by an order of magnitude in the direction that matters.
    sizeBytes: Math.floor((data.length * 3) / 4),
    data,
    previewUri: saved.uri,
  }
}

/**
 * Pick arbitrary documents.
 *
 * `copyToCacheDirectory` is on because the URI a content provider hands back is
 * frequently a one-shot grant revoked the moment the picker closes — reading it
 * afterwards throws a permission error that reads like a corrupt file.
 */
export async function pickDocuments(): Promise<PickOutcome> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: '*/*',
    })

    if (result.canceled) return { ok: false, reason: 'cancelled' }

    const attachments: DraftAttachment[] = []
    for (const asset of result.assets ?? []) {
      const file = new File(asset.uri)
      const data = await file.base64()
      attachments.push({
        id: nextId(),
        name: asset.name || 'file',
        mimeType: asset.mimeType || 'application/octet-stream',
        sizeBytes: asset.size ?? file.size ?? Math.floor((data.length * 3) / 4),
        data,
      })
    }
    return { ok: true, attachments }
  } catch (err) {
    return { ok: false, reason: 'failed', message: describe(err) }
  }
}

function guessImageMime(uri: string): string {
  const lower = uri.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return '.jpg'
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Convert a composer draft into the shape that goes on the wire. */
export function toChatAttachment(draft: DraftAttachment): ChatAttachment {
  return {
    type: attachmentKindFor(draft.mimeType),
    source: { type: 'base64', media_type: draft.mimeType, data: draft.data },
    name: draft.name,
    sizeBytes: draft.sizeBytes,
  }
}

/**
 * One line describing an attachment, for the chip and the transcript row.
 *
 * The transcript keeps the *description*, never the payload: base64 blobs held
 * in transcript state for the life of a session are megabytes per image, for
 * something nothing re-renders.
 */
export function describeAttachment(draft: DraftAttachment): string {
  return `${draft.name} · ${formatBytes(draft.sizeBytes)}`
}

/** Encoded size of a draft set, for the budget check before sending. */
export function draftEncodedSize(drafts: readonly DraftAttachment[]): number {
  return drafts.reduce((sum, d) => sum + encodedSize(d.sizeBytes), 0)
}
