/**
 * Object naming and validation for invoice attachments.
 *
 * Pure, so the rules that keep one invoice's files out of another's folder can
 * be tested without Storage. The server builds every path from these; the
 * browser is never trusted to name anything.
 */

/** 20 MB, matching the file_size_limit set on the bucket itself. Storage
 *  enforces its own copy, so a forged direct upload cannot exceed it either. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Mirrors allowed_mime_types on the bucket. Kept in step deliberately: this
 *  one produces a readable message, the bucket's is the real gate. */
export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/plain',
]

/** Strip control characters. Done by codepoint rather than a regex range:
 *  written literally those bytes make the source file binary, and grep and
 *  git diff then skip it without saying so. */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
}

/**
 * A filename safe to use as the tail of an object key.
 *
 * Strips anything that could climb out of the invoice's folder or confuse the
 * storage API: separators, control characters, leading dots. Keeps the
 * extension, because the download link and Xero both key off it.
 */
export function safeAttachmentName(filename: string): string {
  const trimmed = String(filename ?? '').trim()
  // Take the last segment first, so "../../etc/passwd" becomes "passwd".
  const base = trimmed.split(/[/\\]/).pop() ?? ''
  const cleaned = stripControlChars(base)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
  const safe = cleaned || 'file'
  // Postgres and Storage both cope with long keys, but a 300-character
  // filename in a list view helps nobody. Trimmed from the FRONT so the
  // extension survives.
  return safe.length > 120 ? safe.slice(safe.length - 120) : safe
}

/** The object key for a new attachment: always inside the invoice's own
 *  folder, with a uuid so two uploads of the same filename never collide. */
export function attachmentStoragePath(invoiceId: string, uniqueId: string, filename: string): string {
  return `${invoiceId}/${uniqueId}-${safeAttachmentName(filename)}`
}

/**
 * Whether a path the client handed back really belongs to this invoice.
 *
 * The finish step trusts the client for the path (it is echoing what the begin
 * step returned), so this is what stops a crafted call from recording another
 * invoice's object, or one outside the folder scheme entirely.
 */
export function isPathInsideInvoice(path: string, invoiceId: string): boolean {
  const value = String(path ?? '')
  if (value.includes('..')) return false
  const prefix = `${invoiceId}/`
  if (!value.startsWith(prefix)) return false
  const rest = value.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/')
}

export type AttachmentCheck = { ok: true } | { ok: false; error: string }

/** Size and type, checked before a signed upload url is minted. */
export function checkAttachment(contentType: string, sizeBytes: number): AttachmentCheck {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: 'That file appears to be empty.' }
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'Attachments are limited to 20 MB each.' }
  }
  if (!ALLOWED_ATTACHMENT_TYPES.includes(contentType)) {
    return {
      ok: false,
      error: 'That file type is not accepted. Use a PDF, an image, a Word or Excel document, CSV or plain text.',
    }
  }
  return { ok: true }
}
