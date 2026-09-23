import { isPathInsideInvoice, safeAttachmentName } from '@/lib/customer-invoice/attachment-path'

/**
 * Object naming and limits for purchase order attachments.
 *
 * Pure, so the browser can check a file before asking for an upload, and the
 * rules can be tested without Storage.
 *
 * THE BYTES GO BROWSER TO STORAGE, the way invoice attachments already do
 * (src/app/actions/invoicing/attachments.ts). Until 23 Sep 2026 they went
 * through a server action, and Next caps a server action's body at 1 MB: any
 * file over that failed inside Next before the action ran, and the page was
 * replaced by "Something went wrong" (reference 2427372018@E394, "Body exceeded
 * 1 MB limit"), on uploading "H10 2026 Celtic.pdf". The 10 MB the action
 * promised had never been reachable; the one file ever attached was a 10 KB logo.
 */

export const PO_ATTACHMENT_BUCKET = 'po-attachments'

/** 10 MB, the file_size_limit on the bucket (20260624000400_hub_po_attachments.sql).
 *  Storage enforces its own copy, so a forged direct upload cannot exceed it. */
export const PO_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** Mirrors allowed_mime_types on the bucket. This copy gives a readable refusal;
 *  the bucket's is the real gate. */
export const PO_ATTACHMENT_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]

/** The object key for a new attachment: always inside the order's own folder,
 *  with a uuid so two uploads of the same filename never collide. */
export function poAttachmentPath(poId: string, uniqueId: string, filename: string): string {
  return `${poId}/${uniqueId}-${safeAttachmentName(filename)}`
}

/**
 * Whether a path the browser handed back belongs to this order.
 *
 * The finish step receives the path from the browser (it is echoing what the
 * begin step returned), so this is what stops a crafted call recording another
 * order's object. The rule is the invoice one: one segment inside the folder.
 */
export function isPathInsidePo(path: string, poId: string): boolean {
  return isPathInsideInvoice(path, poId)
}

export type PoAttachmentCheck = { ok: true } | { ok: false; error: string }

/** Size and type, checked before a signed upload is minted. */
export function checkPoAttachment(contentType: string, sizeBytes: number): PoAttachmentCheck {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: 'That file appears to be empty.' }
  }
  if (sizeBytes > PO_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: 'Files are limited to 10 MB each.' }
  }
  if (!PO_ATTACHMENT_TYPES.includes(contentType)) {
    return {
      ok: false,
      error: 'That file type is not accepted. Use a PDF, an image, a Word or Excel document, CSV or plain text.',
    }
  }
  return { ok: true }
}
