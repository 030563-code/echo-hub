import { NextResponse } from 'next/server'
import { z } from 'zod'
import { bearerAuthorized } from '@/lib/machine-auth'
import { recordExtraction } from '@/lib/customs/store.server'

// ---------------------------------------------------------------------------
// POST /api/customs/extraction — Claude's reading of a Nippon Express PDF, from n8n.
//
// n8n posts what Claude returned for customsPackageSchema, plus the Group bills the entry names as
// they stand in Xero (for the inventory clearing accounts), or an error. The Hub validates it,
// links the shipment, marks a resend, and for a new invoice from the inbox makes the draft bill in
// Xero ("Draft initially then Dave approves it in the hub").
//
// Auth: the same bearer as /api/customs/ingest. Listed in SELF_AUTHENTICATED_PATHS.
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 1_000_000

const extractionBodySchema = z.object({
  bill_id: z.string().uuid(),
  model: z.string().trim().max(100).nullish(),
  extraction: z.unknown().optional(),
  group_bills: z.unknown().optional(),
  error: z.string().trim().max(2000).nullish(),
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

  const parsed = extractionBodySchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return NextResponse.json({ ok: false, error: `${issue?.path.join('.')}: ${issue?.message}` }, { status: 400 })
  }

  const outcome = await recordExtraction({
    billId: parsed.data.bill_id,
    model: parsed.data.model ?? null,
    extraction: parsed.data.extraction,
    groupBills: parsed.data.group_bills,
    error: parsed.data.error ?? null,
  })
  if (!outcome.ok) return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.status })
  return NextResponse.json(outcome)
}
