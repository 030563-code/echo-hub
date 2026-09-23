import { NextResponse } from 'next/server'
import { z } from 'zod'
import { bearerAuthorized } from '@/lib/machine-auth'
import { kickHistoryQueue, requestOcr, storeIncomingPdf, xeroLinesSchema } from '@/lib/customs/store.server'

// ---------------------------------------------------------------------------
// POST /api/customs/ingest — a Nippon Express PDF, from n8n.
//
// Two callers: the watcher on Dave's n8n (a new email from @nipponexpress.com with a PDF), and the
// one-off history run on medes (the scans already attached to the 31 bills in Xero, with the bill's
// id and lines so the Hub never makes a second one).
//
// Auth: `authorization: Bearer ${CUSTOMS_INGEST_SECRET}`, constant time, failing closed when the
// variable is unset (src/lib/machine-auth.ts). Listed in SELF_AUTHENTICATED_PATHS in
// src/middleware.ts, or a cookieless POST is redirected to /login and n8n records a success.
//
// Idempotent on the file: the same PDF twice is one row, answered with the same id.
// ---------------------------------------------------------------------------

/** A package is three to seven scanned pages, 200 to 600 KB. Netlify refuses a body over 6 MB. */
const MAX_BODY_CHARS = 6_000_000
const MAX_PDF_BYTES = 20 * 1024 * 1024

const ingestSchema = z.object({
  source: z.enum(['email', 'xero_history']),
  file_name: z.string().trim().min(1).max(300),
  pdf_base64: z.string().min(100),
  gmail_message_id: z.string().trim().max(200).nullish(),
  email_subject: z.string().trim().max(500).nullish(),
  email_received_at: z.string().datetime({ offset: true }).nullish(),
  xero_invoice_id: z.string().uuid().nullish(),
  xero_status: z.string().trim().max(30).nullish(),
  xero_lines: xeroLinesSchema.nullish(),
})

export async function POST(request: Request) {
  if (!bearerAuthorized(request.headers.get('authorization'), process.env.CUSTOMS_INGEST_SECRET)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const text = await request.text()
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ ok: false, error: 'body is not json' }, { status: 400 })
  }

  const parsed = ingestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return NextResponse.json({ ok: false, error: `${issue?.path.join('.')}: ${issue?.message}` }, { status: 400 })
  }
  const input = parsed.data

  const bytes = Buffer.from(input.pdf_base64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
    return NextResponse.json({ ok: false, error: 'the pdf is empty or larger than 20 MB' }, { status: 400 })
  }
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return NextResponse.json({ ok: false, error: 'the file is not a PDF' }, { status: 400 })
  }

  const stored = await storeIncomingPdf({
    source: input.source,
    fileName: input.file_name,
    bytes,
    gmailMessageId: input.gmail_message_id ?? null,
    emailSubject: input.email_subject ?? null,
    emailReceivedAt: input.email_received_at ?? null,
    xeroInvoiceId: input.xero_invoice_id ?? null,
    xeroStatus: input.xero_status ?? null,
    xeroLines: input.xero_lines ?? null,
  })
  if (!stored.ok) return NextResponse.json({ ok: false, error: stored.error }, { status: 500 })

  // A file already here was already sent to be read; sending it again would pay Claude twice.
  if (stored.duplicate) return NextResponse.json({ ok: true, id: stored.id, duplicate: true, ocr: 'already' })

  // History goes through a queue, one at a time (kickHistoryQueue); a new invoice is read now.
  if (input.source === 'xero_history') {
    await kickHistoryQueue()
    return NextResponse.json({ ok: true, id: stored.id, duplicate: false, ocr: 'queued' })
  }

  const ocr = await requestOcr(stored.id)
  return NextResponse.json({
    ok: true,
    id: stored.id,
    duplicate: false,
    ocr: ocr.ok ? 'requested' : 'not_requested',
    ...(ocr.ok ? {} : { ocr_error: ocr.error }),
  })
}
