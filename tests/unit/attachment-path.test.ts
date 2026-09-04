import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  attachmentStoragePath,
  checkAttachment,
  isPathInsideInvoice,
  safeAttachmentName,
} from '@/lib/customer-invoice/attachment-path'

const INVOICE = '79fe6d34-1e0b-4990-9c2b-627874c1a0f5'
const OTHER = '00000000-0000-0000-0000-000000000000'

describe('safeAttachmentName', () => {
  it('keeps an ordinary filename and its extension', () => {
    expect(safeAttachmentName('Purchase Order 1234.pdf')).toBe('Purchase-Order-1234.pdf')
  })

  it('takes only the last segment, so a traversal cannot survive', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentName('C:\\Users\\dean\\secret.pdf')).toBe('secret.pdf')
  })

  it('strips control characters rather than turning them into separators', () => {
    expect(safeAttachmentName('a\u0000b\u001fc.pdf')).toBe('abc.pdf')
  })

  it('never starts with a dot or a dash', () => {
    expect(safeAttachmentName('.hidden')).toBe('hidden')
    expect(safeAttachmentName('---x.pdf')).toBe('x.pdf')
  })

  it('falls back to a name rather than returning empty', () => {
    expect(safeAttachmentName('')).toBe('file')
    expect(safeAttachmentName('///')).toBe('file')
  })

  it('caps the length, keeping the end so the extension survives', () => {
    const long = `${'a'.repeat(400)}.pdf`
    const safe = safeAttachmentName(long)
    expect(safe.length).toBeLessThanOrEqual(120)
    expect(safe.endsWith('.pdf')).toBe(true)
  })
})

describe('attachmentStoragePath', () => {
  it('puts every object inside the invoice folder', () => {
    expect(attachmentStoragePath(INVOICE, 'abc', 'PO.pdf')).toBe(`${INVOICE}/abc-PO.pdf`)
  })

  it('produces a path that passes its own containment check', () => {
    const path = attachmentStoragePath(INVOICE, 'abc', '../escape.pdf')
    expect(isPathInsideInvoice(path, INVOICE)).toBe(true)
  })
})

/** This is the guard that stops a crafted finish call from recording another
 *  invoice's object, so each way out of the folder gets its own case. */
describe('isPathInsideInvoice', () => {
  it('accepts a path directly inside the folder', () => {
    expect(isPathInsideInvoice(`${INVOICE}/abc-PO.pdf`, INVOICE)).toBe(true)
  })

  it('refuses another invoice folder', () => {
    expect(isPathInsideInvoice(`${OTHER}/abc-PO.pdf`, INVOICE)).toBe(false)
  })

  it('refuses a traversal', () => {
    expect(isPathInsideInvoice(`${INVOICE}/../${OTHER}/x.pdf`, INVOICE)).toBe(false)
  })

  it('refuses a nested folder, which the scheme never creates', () => {
    expect(isPathInsideInvoice(`${INVOICE}/sub/x.pdf`, INVOICE)).toBe(false)
  })

  it('refuses the bare folder and an empty path', () => {
    expect(isPathInsideInvoice(`${INVOICE}/`, INVOICE)).toBe(false)
    expect(isPathInsideInvoice('', INVOICE)).toBe(false)
  })

  it('refuses a prefix that merely starts the same', () => {
    expect(isPathInsideInvoice(`${INVOICE}extra/x.pdf`, INVOICE)).toBe(false)
  })
})

describe('checkAttachment', () => {
  it('accepts a PDF within the limit', () => {
    expect(checkAttachment('application/pdf', 1024)).toEqual({ ok: true })
  })

  it('refuses an empty file', () => {
    expect(checkAttachment('application/pdf', 0).ok).toBe(false)
  })

  it('refuses over 20 MB, and accepts exactly 20 MB', () => {
    expect(checkAttachment('application/pdf', MAX_ATTACHMENT_BYTES + 1).ok).toBe(false)
    expect(checkAttachment('application/pdf', MAX_ATTACHMENT_BYTES).ok).toBe(true)
  })

  it('refuses a type the bucket would reject anyway', () => {
    expect(checkAttachment('application/x-msdownload', 1024).ok).toBe(false)
  })

  it('allows every type the bucket allows', () => {
    for (const type of ALLOWED_ATTACHMENT_TYPES) {
      expect(checkAttachment(type, 1024)).toEqual({ ok: true })
    }
  })
})
