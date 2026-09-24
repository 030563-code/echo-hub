import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { customsPackageSchema, customsChargeOf, type CustomsPackage } from '@/lib/customs/nippon-invoice'
import { matchShipment, type ShipmentKeys } from '@/lib/customs/match'
import { buildXeroBill, type GroupBill } from '@/lib/customs/xero-bill'
import { checkPackage, holdsDraftBack } from '@/lib/customs/checks'
import { checksFingerprint } from '@/lib/customs/view'
import { callCustomsWebhook, type XeroBillLineOut } from '@/lib/customs/n8n.server'

/**
 * The customs bills: the PDF, what Claude read off it, the shipment, and Xero.
 *
 * Every write goes through here with the service role, and only after the caller was checked:
 * the two machine endpoints by their bearer secret, Dave's actions by customs.manage.
 */

export const CUSTOMS_BUCKET = 'customs-documents'

/** Long enough for n8n to fetch the scan and hand it to Claude; a copied link soon dies. */
const MACHINE_URL_TTL_SECONDS = 30 * 60
/** For Dave's click on "Open the PDF". */
const VIEW_URL_TTL_SECONDS = 5 * 60

export type CustomsSource = 'email' | 'xero_history'
export type OcrStatus = 'pending' | 'requested' | 'done' | 'failed'

export interface CustomsBillRow {
  id: string
  source: CustomsSource
  file_sha256: string
  file_name: string
  storage_path: string
  file_size: number | null
  gmail_message_id: string | null
  email_subject: string | null
  email_received_at: string | null
  ocr_status: OcrStatus
  ocr_requested_at: string | null
  ocr_at: string | null
  ocr_model: string | null
  ocr_error: string | null
  extraction: unknown
  group_bills: unknown
  invoice_number: string | null
  invoice_date: string | null
  invoice_total: number | null
  entry_number: string | null
  entry_date: string | null
  customs_total: number | null
  duplicate_of: string | null
  spot_id: string | null
  match_method: 'spot' | 'container' | 'mbl' | 'hbl' | null
  xero_invoice_id: string | null
  xero_status: string | null
  xero_lines: unknown
  xero_synced_at: string | null
  xero_error: string | null
  approved_by_uid: string | null
  approved_at: string | null
  /** What Claude read, kept the first time Dave corrected the reading. */
  extraction_original?: unknown
  edited_by_uid?: string | null
  edited_at?: string | null
  reviewed_by_uid?: string | null
  reviewed_at?: string | null
  review_note?: string | null
  reviewed_checks?: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = '*'

const groupBillsSchema = z.array(
  z.object({
    number: z.string().trim().min(1),
    lines: z.array(
      z.object({
        description: z.string().default(''),
        amount: z.number().finite(),
        accountCode: z.string().trim().min(1).nullish().transform((v) => v ?? null),
      }),
    ),
  }),
)

export const xeroLinesSchema = z.array(
  z.object({
    description: z.string().default(''),
    amount: z.number().finite(),
    accountCode: z.string().trim().min(1).nullish().transform((v) => v ?? null),
  }),
)

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

function normaliseRow(row: Record<string, unknown>): CustomsBillRow {
  return {
    ...(row as unknown as CustomsBillRow),
    file_size: num(row.file_size),
    invoice_total: num(row.invoice_total),
    customs_total: num(row.customs_total),
  }
}

/** The reading as stored, re-validated, so a row written by an older schema cannot break a page. */
export function packageOf(row: Pick<CustomsBillRow, 'extraction'>): CustomsPackage | null {
  const parsed = customsPackageSchema.safeParse(row.extraction)
  return parsed.success ? parsed.data : null
}

export function groupBillsOf(row: Pick<CustomsBillRow, 'group_bills'>): GroupBill[] {
  const parsed = groupBillsSchema.safeParse(row.group_bills)
  return parsed.success ? parsed.data : []
}

export function xeroLinesOf(row: Pick<CustomsBillRow, 'xero_lines'>): XeroBillLineOut[] | null {
  const parsed = xeroLinesSchema.safeParse(row.xero_lines)
  return parsed.success ? parsed.data : null
}

export async function listCustomsBills(): Promise<CustomsBillRow[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('customs_bills')
    .select(COLUMNS)
    .order('invoice_date', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(`customs bills could not be read: ${error.message}`)
  return (data ?? []).map((r) => normaliseRow(r as Record<string, unknown>))
}

export async function loadCustomsBill(id: string): Promise<CustomsBillRow | null> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('customs_bills').select(COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`customs bill could not be read: ${error.message}`)
  return data ? normaliseRow(data as Record<string, unknown>) : null
}

export async function customsBillsForSpot(spotId: string): Promise<CustomsBillRow[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('customs_bills')
    .select(COLUMNS)
    .eq('spot_id', spotId)
    .is('duplicate_of', null)
    .order('invoice_date', { ascending: false })
  if (error) throw new Error(`customs bills could not be read: ${error.message}`)
  return (data ?? []).map((r) => normaliseRow(r as Record<string, unknown>))
}

export async function customsPdfUrl(row: Pick<CustomsBillRow, 'storage_path'>, seconds = VIEW_URL_TTL_SECONDS): Promise<string | null> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(CUSTOMS_BUCKET).createSignedUrl(row.storage_path, seconds)
  if (error || !data) {
    console.error('customs pdf could not be signed', error?.message)
    return null
  }
  return data.signedUrl
}

// ---------------------------------------------------------------------------
// In: a PDF from Dave's inbox, or from a bill already in Xero
// ---------------------------------------------------------------------------

export interface IncomingPdf {
  source: CustomsSource
  fileName: string
  bytes: Buffer
  gmailMessageId?: string | null
  emailSubject?: string | null
  emailReceivedAt?: string | null
  xeroInvoiceId?: string | null
  xeroStatus?: string | null
  xeroLines?: XeroBillLineOut[] | null
}

/**
 * Keep the PDF once. The fingerprint is the file itself, so the same attachment arriving twice
 * (a poll that re-reads, a forward, the history run on a bill that also came by email) is one row.
 */
export async function storeIncomingPdf(
  pdf: IncomingPdf,
): Promise<{ ok: true; id: string; duplicate: boolean } | { ok: false; error: string }> {
  const sha = createHash('sha256').update(pdf.bytes).digest('hex')
  const admin = createAdminClient()

  const { data: existing } = await admin.from('customs_bills').select('id, xero_invoice_id').eq('file_sha256', sha).maybeSingle()
  if (existing) {
    if (pdf.xeroInvoiceId && !existing.xero_invoice_id) {
      await admin
        .from('customs_bills')
        .update({ xero_invoice_id: pdf.xeroInvoiceId, xero_status: pdf.xeroStatus ?? null, xero_lines: pdf.xeroLines ?? null, xero_synced_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { ok: true, id: existing.id as string, duplicate: true }
  }

  const path = `${new Date().toISOString().slice(0, 7)}/${sha}.pdf`
  const { error: uploadError } = await admin.storage.from(CUSTOMS_BUCKET).upload(path, pdf.bytes, {
    contentType: 'application/pdf',
    upsert: false,
  })
  // An object left by an earlier attempt whose row never landed is the same file; keep going.
  if (uploadError && !/exists|duplicate/i.test(uploadError.message)) {
    console.error('customs pdf upload failed', uploadError.message)
    return { ok: false, error: 'The PDF could not be stored.' }
  }

  const { data: inserted, error: insertError } = await admin
    .from('customs_bills')
    .insert({
      source: pdf.source,
      file_sha256: sha,
      file_name: pdf.fileName,
      storage_path: path,
      file_size: pdf.bytes.length,
      gmail_message_id: pdf.gmailMessageId ?? null,
      email_subject: pdf.emailSubject ?? null,
      email_received_at: pdf.emailReceivedAt ?? null,
      xero_invoice_id: pdf.xeroInvoiceId ?? null,
      xero_status: pdf.xeroStatus ?? null,
      xero_lines: pdf.xeroLines ?? null,
      xero_synced_at: pdf.xeroInvoiceId ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (insertError || !inserted) {
    // Two deliveries of the same file at once: the other one won, and that is the row.
    const { data: raced } = await admin.from('customs_bills').select('id').eq('file_sha256', sha).maybeSingle()
    if (raced) return { ok: true, id: raced.id as string, duplicate: true }
    console.error('customs bill insert failed', insertError?.message)
    return { ok: false, error: 'The PDF could not be recorded.' }
  }
  return { ok: true, id: inserted.id as string, duplicate: false }
}

/** A reading asked for this long ago and never answered is taken as lost, so the queue moves on. */
const HISTORY_STALL_MS = 15 * 60 * 1000

/**
 * The bills read from history go to Claude one at a time: each finished reading asks for the next.
 *
 * 31 scans at once would meet a new Anthropic key's rate limit in the first minute, and one n8n
 * run spacing them out would run for half an hour. A queue in the table costs nothing: the next
 * pending row is sent only when no other history row is out being read.
 */
export async function kickHistoryQueue(): Promise<void> {
  const admin = createAdminClient()
  const { data: inFlight } = await admin
    .from('customs_bills')
    .select('id, ocr_requested_at')
    .eq('source', 'xero_history')
    .eq('ocr_status', 'requested')
  const live = (inFlight ?? []).filter(
    (r) => r.ocr_requested_at && Date.now() - Date.parse(String(r.ocr_requested_at)) < HISTORY_STALL_MS,
  )
  if (live.length > 0) return

  const { data: next } = await admin
    .from('customs_bills')
    .select('id')
    .eq('source', 'xero_history')
    .eq('ocr_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (next) await requestOcr(String(next.id))
}

/** Ask n8n to have Claude read it. The reading comes back to /api/customs/extraction. */
export async function requestOcr(billId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await loadCustomsBill(billId)
  if (!row) return { ok: false, error: 'No such customs bill.' }
  const url = await customsPdfUrl(row, MACHINE_URL_TTL_SECONDS)
  if (!url) return { ok: false, error: 'Could not make a link to the PDF.' }

  const admin = createAdminClient()
  const result = await callCustomsWebhook({ action: 'ocr', bill_id: row.id, file_name: row.file_name, pdf_url: url })
  if (!result.ok) {
    await admin.from('customs_bills').update({ ocr_error: result.error }).eq('id', row.id)
    return result
  }
  await admin
    .from('customs_bills')
    .update({ ocr_status: 'requested', ocr_requested_at: new Date().toISOString(), ocr_error: null })
    .eq('id', row.id)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Back: what Claude read
// ---------------------------------------------------------------------------

async function shipmentCandidates(): Promise<ShipmentKeys[]> {
  const admin = createAdminClient()
  const [{ data: shipments }, { data: containers }] = await Promise.all([
    admin.from('cargo_shipment').select('spot_id, hbl, mbl'),
    admin.from('cargo_container').select('spot_id, container_number'),
  ])
  const bySpot = new Map<string, string[]>()
  for (const c of containers ?? []) {
    if (!c.container_number) continue
    const list = bySpot.get(String(c.spot_id)) ?? []
    list.push(String(c.container_number))
    bySpot.set(String(c.spot_id), list)
  }
  return (shipments ?? []).map((s) => ({
    spotId: String(s.spot_id),
    hbl: s.hbl ? String(s.hbl) : null,
    mbl: s.mbl ? String(s.mbl) : null,
    containers: bySpot.get(String(s.spot_id)) ?? [],
  }))
}

export interface ExtractionIn {
  billId: string
  model?: string | null
  extraction?: unknown
  groupBills?: unknown
  error?: string | null
}

export type ExtractionOutcome =
  | { ok: true; invoiceNumber: string; spotId: string | null; duplicateOf: string | null; draft: 'created' | 'existing' | 'skipped' | 'held' | 'failed' }
  | { ok: false; status: number; error: string }

export async function recordExtraction(input: ExtractionIn): Promise<ExtractionOutcome> {
  const row = await loadCustomsBill(input.billId)
  if (!row) return { ok: false, status: 404, error: 'No such customs bill.' }
  const admin = createAdminClient()
  const now = new Date().toISOString()

  if (input.error) {
    await admin
      .from('customs_bills')
      .update({ ocr_status: 'failed', ocr_error: input.error.slice(0, 1000), ocr_at: now, ocr_model: input.model ?? null })
      .eq('id', row.id)
    if (row.source === 'xero_history') await kickHistoryQueue()
    return { ok: false, status: 200, error: 'Recorded as failed.' }
  }

  const parsed = customsPackageSchema.safeParse(input.extraction)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = `The reading did not have the expected shape: ${issue?.path.join('.') || 'root'} ${issue?.message ?? ''}`.trim()
    await admin
      .from('customs_bills')
      .update({ ocr_status: 'failed', ocr_error: message.slice(0, 1000), ocr_at: now, ocr_model: input.model ?? null, extraction: input.extraction ?? null })
      .eq('id', row.id)
    if (row.source === 'xero_history') await kickHistoryQueue()
    return { ok: false, status: 422, error: message }
  }
  const pkg = parsed.data
  const bills = groupBillsSchema.safeParse(input.groupBills ?? [])

  const match = matchShipment(pkg, await shipmentCandidates())

  // A resend of an invoice already here points at the first copy and is never billed twice.
  const { data: first } = await admin
    .from('customs_bills')
    .select('id')
    .eq('invoice_number', pkg.invoice.invoice_number)
    .is('duplicate_of', null)
    .neq('id', row.id)
    .maybeSingle()
  const duplicateOf = first ? (first.id as string) : null

  const { error: updateError } = await admin
    .from('customs_bills')
    .update({
      ocr_status: 'done',
      ocr_at: now,
      ocr_model: input.model ?? null,
      ocr_error: null,
      extraction: pkg,
      group_bills: bills.success ? bills.data : [],
      invoice_number: pkg.invoice.invoice_number,
      invoice_date: pkg.invoice.invoice_date,
      invoice_total: pkg.invoice.total,
      entry_number: pkg.entry?.entry_number ?? null,
      entry_date: pkg.entry?.entry_date ?? null,
      customs_total: pkg.entry?.total ?? customsChargeOf(pkg.invoice)?.amount ?? null,
      spot_id: match?.spotId ?? null,
      match_method: match?.method ?? null,
      duplicate_of: duplicateOf,
    })
    .eq('id', row.id)
  if (updateError) {
    console.error('customs extraction could not be stored', updateError.message)
    return { ok: false, status: 500, error: 'The reading could not be stored.' }
  }

  // "Draft initially": a new invoice from the inbox becomes a draft bill in Xero straight away.
  // One from history is already in Xero, and a resend never is. Nor is a PDF that is not an
  // invoice, or one whose sums fail: those wait for Dave to look and press Make the draft.
  let draft: 'created' | 'existing' | 'skipped' | 'held' | 'failed' = 'skipped'
  const heldBack = holdsDraftBack(pkg)
  if (row.source === 'email' && !duplicateOf && !row.xero_invoice_id && heldBack) draft = 'held'
  else if (row.source === 'email' && !duplicateOf && !row.xero_invoice_id) {
    const made = await requestDraft(row.id)
    draft = made.ok ? (made.existing ? 'existing' : 'created') : 'failed'
  }
  if (row.source === 'xero_history') await kickHistoryQueue()

  return { ok: true, invoiceNumber: pkg.invoice.invoice_number, spotId: match?.spotId ?? null, duplicateOf, draft }
}

// ---------------------------------------------------------------------------
// Xero
// ---------------------------------------------------------------------------

export async function requestDraft(
  billId: string,
): Promise<{ ok: true; existing: boolean } | { ok: false; error: string }> {
  const row = await loadCustomsBill(billId)
  if (!row) return { ok: false, error: 'No such customs bill.' }
  if (row.xero_invoice_id) return { ok: true, existing: true }
  if (row.duplicate_of) return { ok: false, error: 'This PDF is a resend of an invoice already in the Hub.' }
  const pkg = packageOf(row)
  if (!pkg) return { ok: false, error: 'Claude has not read this PDF yet.' }

  const bill = buildXeroBill(pkg, groupBillsOf(row))
  const url = await customsPdfUrl(row, MACHINE_URL_TTL_SECONDS)
  if (!url) return { ok: false, error: 'Could not make a link to the PDF.' }

  const admin = createAdminClient()
  const result = await callCustomsWebhook({ action: 'create_draft', bill_id: row.id, bill, file_name: row.file_name, pdf_url: url })
  if (!result.ok || !result.xero_invoice_id) {
    const error = result.ok ? 'n8n did not return the Xero bill.' : result.error
    await admin.from('customs_bills').update({ xero_error: error }).eq('id', row.id)
    return { ok: false, error }
  }
  await admin
    .from('customs_bills')
    .update({
      xero_invoice_id: result.xero_invoice_id,
      xero_status: result.xero_status ?? 'DRAFT',
      xero_lines: result.xero_lines ?? null,
      xero_synced_at: new Date().toISOString(),
      xero_error: null,
    })
    .eq('id', row.id)
  return { ok: true, existing: result.existing === true }
}

/** Dave approved it in the Hub: authorise the draft in Xero. */
export async function authoriseInXero(
  billId: string,
  approverUid: string,
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const row = await loadCustomsBill(billId)
  if (!row) return { ok: false, error: 'No such customs bill.' }
  if (!row.xero_invoice_id) return { ok: false, error: 'There is no draft bill in Xero for this invoice yet.' }
  if (row.xero_status && row.xero_status !== 'DRAFT' && row.xero_status !== 'SUBMITTED') {
    return { ok: false, error: `The bill is already ${row.xero_status.toLowerCase()} in Xero.` }
  }

  const admin = createAdminClient()
  const result = await callCustomsWebhook({ action: 'authorise', bill_id: row.id, xero_invoice_id: row.xero_invoice_id })
  if (!result.ok) {
    await admin.from('customs_bills').update({ xero_error: result.error }).eq('id', row.id)
    return result
  }
  const status = result.xero_status ?? 'AUTHORISED'
  await admin
    .from('customs_bills')
    .update({
      xero_status: status,
      xero_lines: result.xero_lines ?? row.xero_lines ?? null,
      xero_synced_at: new Date().toISOString(),
      xero_error: null,
      approved_by_uid: approverUid,
      approved_at: new Date().toISOString(),
    })
    .eq('id', row.id)
  return { ok: true, status }
}

// ---------------------------------------------------------------------------
// Dave's corrections
// ---------------------------------------------------------------------------

/**
 * Dave has looked at what is flagged and is content with it. The sign-off carries the checks it
 * was given against, so it lapses by itself if the reading changes and the checks with it.
 */
export async function markChecked(
  billId: string,
  uid: string,
  note: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await loadCustomsBill(billId)
  if (!row) return { ok: false, error: 'No such customs bill.' }
  const pkg = packageOf(row)
  if (row.ocr_status !== 'done' || !pkg) return { ok: false, error: 'Claude has not read this PDF yet.' }
  const check = checkPackage(pkg)
  if (check.worst === 'ok') return { ok: false, error: 'Nothing on this bill is flagged.' }
  const { error } = await createAdminClient()
    .from('customs_bills')
    .update({
      reviewed_by_uid: uid,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      reviewed_checks: checksFingerprint(check),
    })
    .eq('id', row.id)
  if (error) return { ok: false, error: 'The check could not be saved.' }
  return { ok: true }
}

export async function clearChecked(billId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await createAdminClient()
    .from('customs_bills')
    .update({ reviewed_by_uid: null, reviewed_at: null, review_note: null, reviewed_checks: null })
    .eq('id', billId)
  if (error) return { ok: false, error: 'The check could not be undone.' }
  return { ok: true }
}

/**
 * The reading put right by hand: a misread figure, or the entry summary typed from a 7501 that
 * came on its own. Claude's reading is kept the first time. Everything worked from the reading
 * follows it: the checks, the shipment it links to, the Xero draft not yet made and the landed
 * cost. A draft already in Xero is not changed by this.
 */
export async function saveEditedReading(
  billId: string,
  pkg: CustomsPackage,
  uid: string,
): Promise<{ ok: true; spotId: string | null } | { ok: false; error: string }> {
  const row = await loadCustomsBill(billId)
  if (!row) return { ok: false, error: 'No such customs bill.' }
  if (row.ocr_status !== 'done') return { ok: false, error: 'Claude has not read this PDF yet. Read it first, then correct it.' }
  const admin = createAdminClient()

  if (pkg.invoice.invoice_number !== row.invoice_number && !row.duplicate_of) {
    const { data: other } = await admin
      .from('customs_bills')
      .select('id')
      .eq('invoice_number', pkg.invoice.invoice_number)
      .is('duplicate_of', null)
      .neq('id', row.id)
      .maybeSingle()
    if (other) return { ok: false, error: `Another bill in the Hub is already ${pkg.invoice.invoice_number}.` }
  }

  const match = matchShipment(pkg, await shipmentCandidates())
  const { error } = await admin
    .from('customs_bills')
    .update({
      extraction: pkg,
      extraction_original: row.extraction_original ?? row.extraction,
      edited_by_uid: uid,
      edited_at: new Date().toISOString(),
      invoice_number: pkg.invoice.invoice_number,
      invoice_date: pkg.invoice.invoice_date,
      invoice_total: pkg.invoice.total,
      entry_number: pkg.entry?.entry_number ?? null,
      entry_date: pkg.entry?.entry_date ?? null,
      customs_total: pkg.entry?.total ?? customsChargeOf(pkg.invoice)?.amount ?? null,
      spot_id: match?.spotId ?? null,
      match_method: match?.method ?? null,
    })
    .eq('id', row.id)
  if (error) {
    if (error.code === '23505') return { ok: false, error: `Another bill in the Hub is already ${pkg.invoice.invoice_number}.` }
    return { ok: false, error: 'The reading could not be saved.' }
  }
  return { ok: true, spotId: match?.spotId ?? null }
}
