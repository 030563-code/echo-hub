'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  attachmentStoragePath,
  checkAttachment,
  isPathInsideInvoice,
  safeAttachmentName,
} from '@/lib/customer-invoice/attachment-path'
import { loadInvoiceWithLines, requireInvoicingManage } from './shared'

/**
 * Files a reviewer attaches to a customer invoice.
 *
 * THE BYTES NEVER PASS THROUGH THE SERVER. Next's default request body limit is
 * 1 MB, and base64 inflates by a third, so an attachment posted through a
 * server action would be capped near 750 KB. Instead the browser uploads
 * straight to Storage with a signed token minted here against a path the SERVER
 * chose, then calls back to record the row. That also means a 20 MB file costs
 * the app nothing but two small round trips.
 *
 * What keeps it safe, given a signed upload token bypasses RLS by design:
 *
 *   - every action starts with requireInvoicingManage and loads the invoice,
 *   - the path is always '<invoice id>/<uuid>-<safe name>', built here, so a
 *     client cannot name another invoice's folder,
 *   - the finish step re-checks containment and confirms the object really
 *     exists at that path before recording it,
 *   - the bucket is private with its own size and MIME limits, and downloads
 *     are short-lived signed urls minted on click.
 *
 * This is the first use of Storage in the codebase. document-data.ts argues
 * against a bucket for the invoice PDF, and that still holds: the PDF is
 * deterministic and re-rendered on demand, so storing it buys nothing. An
 * attachment exists nowhere else, so it has to be stored.
 */

const BUCKET = 'invoice-attachments'

/** How long a download link lives. Long enough to click, short enough that a
 *  copied url is not a lasting way around the capability check. */
const DOWNLOAD_URL_TTL_SECONDS = 300

export interface InvoiceAttachmentRow {
  id: string
  filename: string
  storage_path: string
  content_type: string | null
  size_bytes: number | null
  uploaded_by_label: string | null
  created_at: string
}

export type BeginUploadResult =
  | { success: true; path: string; token: string }
  | { success: false; error: string }

export type AttachmentActionResult = { success: true } | { success: false; error: string }

export type DownloadUrlResult = { success: true; url: string } | { success: false; error: string }

/**
 * Attachments are a record of the invoice, not part of the document the hash
 * protects, so they stay usable at every status. A voided invoice is the one
 * exception: nothing should accumulate against a document that was withdrawn.
 */
async function loadEditableInvoice(invoiceId: string) {
  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { ok: false as const, error: loaded.error }
  if (loaded.invoice.status === 'voided') {
    return { ok: false as const, error: 'This invoice is voided, so its attachments can no longer be changed.' }
  }
  return { ok: true as const, invoice: loaded.invoice }
}

const BeginInput = z.object({
  invoiceId: z.string().uuid(),
  filename: z.string().trim().min(1).max(300),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
})

export async function beginAttachmentUpload(input: unknown): Promise<BeginUploadResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = BeginInput.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid attachment' }
  }
  const { invoiceId, filename, contentType, sizeBytes } = parsed.data

  const allowed = checkAttachment(contentType, sizeBytes)
  if (!allowed.ok) return { success: false, error: allowed.error }

  const invoice = await loadEditableInvoice(invoiceId)
  if (!invoice.ok) return { success: false, error: invoice.error }

  // The server picks the path. This is the whole containment guarantee.
  const path = attachmentStoragePath(invoiceId, randomUUID(), filename)

  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('createSignedUploadUrl failed', error?.message)
    return { success: false, error: 'Could not start the upload. Please try again.' }
  }

  return { success: true, path: data.path, token: data.token }
}

const FinishInput = z.object({
  invoiceId: z.string().uuid(),
  path: z.string().trim().min(1).max(500),
  filename: z.string().trim().min(1).max(300),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
})

export async function finishAttachmentUpload(input: unknown): Promise<AttachmentActionResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = FinishInput.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid attachment' }
  }
  const { invoiceId, path, filename, contentType, sizeBytes } = parsed.data

  const invoice = await loadEditableInvoice(invoiceId)
  if (!invoice.ok) return { success: false, error: invoice.error }

  // The path comes back from the browser, so it is re-checked rather than
  // trusted: this is what stops a crafted call recording another invoice's file.
  if (!isPathInsideInvoice(path, invoiceId)) {
    return { success: false, error: 'That file does not belong to this invoice.' }
  }

  const admin = createAdminClient()

  // Confirm the object is actually there. Without this the table could record
  // an attachment that no upload ever completed, and the list would offer a
  // download that 404s.
  const objectName = path.slice(invoiceId.length + 1)
  const { data: listed, error: listError } = await admin.storage
    .from(BUCKET)
    .list(invoiceId, { search: objectName, limit: 1 })
  if (listError) {
    console.error('attachment list failed', listError.message)
    return { success: false, error: 'Could not confirm the upload. Please try again.' }
  }
  const object = (listed ?? []).find((item) => item.name === objectName)
  if (!object) {
    return { success: false, error: 'The upload did not complete. Please try again.' }
  }

  const { error: insertError } = await admin.from('invoice_attachments').insert({
    invoice_id: invoiceId,
    filename: safeAttachmentName(filename),
    storage_path: path,
    content_type: contentType,
    size_bytes: sizeBytes,
    uploaded_by_uid: gate.auth.user.id,
    uploaded_by_label: gate.auth.user.email ?? null,
  })
  if (insertError) {
    console.error('invoice_attachments insert failed', insertError.message)
    // The object is uploaded but unrecorded. Remove it rather than leave a file
    // nothing points at.
    await admin.storage.from(BUCKET).remove([path])
    return { success: false, error: 'Could not save the attachment. Please try again.' }
  }

  revalidatePath(`/invoicing/${invoice.invoice.hubspot_deal_id}`)
  return { success: true }
}

const IdInput = z.object({ attachmentId: z.string().uuid() })

export async function deleteInvoiceAttachment(input: unknown): Promise<AttachmentActionResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = IdInput.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid attachment' }

  const admin = createAdminClient()
  const { data: row, error } = await admin
    .from('invoice_attachments')
    .select('id, invoice_id, storage_path')
    .eq('id', parsed.data.attachmentId)
    .maybeSingle()
  if (error) {
    console.error('invoice_attachments load failed', error.message)
    return { success: false, error: 'Could not read that attachment.' }
  }
  if (!row) return { success: false, error: 'That attachment no longer exists.' }

  const invoice = await loadEditableInvoice(row.invoice_id as string)
  if (!invoice.ok) return { success: false, error: invoice.error }

  // Object first: a failed row delete then leaves a broken row the rep can
  // retry, which is easier to notice than a file nothing references.
  const { error: removeError } = await admin.storage.from(BUCKET).remove([row.storage_path as string])
  if (removeError) {
    console.error('attachment remove failed', removeError.message)
    return { success: false, error: 'Could not delete the file. Please try again.' }
  }

  const { error: deleteError } = await admin.from('invoice_attachments').delete().eq('id', row.id)
  if (deleteError) {
    console.error('invoice_attachments delete failed', deleteError.message)
    return { success: false, error: 'The file was removed but the record was not. Reload and try again.' }
  }

  revalidatePath(`/invoicing/${invoice.invoice.hubspot_deal_id}`)
  return { success: true }
}

/**
 * A short-lived link to one attachment.
 *
 * Minted on click rather than rendered into the page, so a url cannot outlive
 * the session that asked for it or be copied out of the HTML.
 */
export async function attachmentDownloadUrl(input: unknown): Promise<DownloadUrlResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = IdInput.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid attachment' }

  const admin = createAdminClient()
  const { data: row, error } = await admin
    .from('invoice_attachments')
    .select('invoice_id, storage_path, filename')
    .eq('id', parsed.data.attachmentId)
    .maybeSingle()
  if (error || !row) return { success: false, error: 'That attachment no longer exists.' }

  // A voided invoice's files stay readable: withdrawing an invoice does not
  // make its paperwork unreadable, it only stops new files being added.
  const loaded = await loadInvoiceWithLines(row.invoice_id as string)
  if (!loaded.ok) return { success: false, error: loaded.error }

  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path as string, DOWNLOAD_URL_TTL_SECONDS, {
      download: row.filename as string,
    })
  if (signError || !data) {
    console.error('createSignedUrl failed', signError?.message)
    return { success: false, error: 'Could not open that file. Please try again.' }
  }

  return { success: true, url: data.signedUrl }
}
