import { describe, expect, it } from 'vitest'
import {
  ChatAttachmentSchema,
  PAYLOAD_MARGIN_BYTES,
  attachmentKindFor,
  encodedSize,
  fitsPayloadBudget,
  formatBytes,
} from './attachments'

const attachment = (dataLength: number) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'a'.repeat(dataLength) },
})

describe('encodedSize', () => {
  it('accounts for base64 inflation and padding', () => {
    expect(encodedSize(3)).toBe(4)
    // The case that matters: a file comfortably under a cap as bytes is over it
    // once encoded, and a check against the raw size passes while the send
    // still kills the socket.
    expect(encodedSize(20 * 1024 * 1024)).toBeGreaterThan(26 * 1024 * 1024)
  })

  it('rounds up rather than down', () => {
    expect(encodedSize(1)).toBe(4)
    expect(encodedSize(4)).toBe(8)
  })
})

describe('fitsPayloadBudget', () => {
  it('accepts a set that fits with the envelope margin', () => {
    expect(fitsPayloadBudget([attachment(1000)], 100, 1_000_000)).toEqual({ ok: true })
  })

  it('rejects a set that only fits without the margin', () => {
    // Being exactly at the boundary is the same failure as being over it: the
    // JSON envelope, session key and idempotency key all still have to fit.
    const limit = PAYLOAD_MARGIN_BYTES + 1000
    const result = fitsPayloadBudget([attachment(1000)], 1, limit)
    expect(result.ok).toBe(false)
  })

  it('reports both figures so the caller can name them', () => {
    const result = fitsPayloadBudget([attachment(5000)], 0, 1000)
    expect(result).toMatchObject({ ok: false, limitBytes: 1000 })
    if (!result.ok) expect(result.totalBytes).toBeGreaterThan(5000)
  })

  it('treats a negative limit as zero rather than inverting the comparison', () => {
    expect(fitsPayloadBudget([], 0, -5).ok).toBe(false)
  })
})

describe('attachmentKindFor', () => {
  it('classifies images, case-insensitively', () => {
    expect(attachmentKindFor('image/png')).toBe('image')
    expect(attachmentKindFor('IMAGE/JPEG')).toBe('image')
  })

  it('sends anything it cannot classify as a document rather than guessing', () => {
    expect(attachmentKindFor('application/pdf')).toBe('document')
    expect(attachmentKindFor('image/heic')).toBe('document')
  })
})

describe('formatBytes', () => {
  it('uses binary units, matching how the payload cap is expressed', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB')
  })

  it('does not invent a figure for nonsense', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('ChatAttachmentSchema', () => {
  it('accepts the wire shape', () => {
    expect(ChatAttachmentSchema.safeParse(attachment(10)).success).toBe(true)
  })

  it('rejects an empty payload', () => {
    const empty = { ...attachment(0), source: { type: 'base64', media_type: 'image/png', data: '' } }
    expect(ChatAttachmentSchema.safeParse(empty).success).toBe(false)
  })
})
