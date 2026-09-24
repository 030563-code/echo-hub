import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { bearerAuthorized } from '@/lib/machine-auth'
import { externalCallsDisabled } from '@/lib/env'
import { MAX_WINDOW_MS, runQuoteSentCheck } from '@/lib/quote-sent/run'
import { hubspotQuoteSentPort } from '@/lib/quote-sent/hubspot.server'
import { supabaseQuoteSentStore } from '@/lib/quote-sent/store.server'

// ---------------------------------------------------------------------------
// POST /api/quotes/detect-sent: the quote-sent check (n8n schedule on medes, every 30 minutes, here).
//
// Dean, 24 Sep 2026: reps do not move their deals from Quote Request to Quotation sent, so once
// HubSpot has logged an email carrying a deal's quote link, the Hub moves the deal itself. The rule
// is src/lib/quote-sent/rule.ts; the run, and why its window chains, is src/lib/quote-sent/run.ts.
//
// Auth: `authorization: Bearer ${MRP_CRON_SECRET}`, the machine secret the n8n cron already holds
// for /api/mrp/run. Fails CLOSED: with the secret unset every request is refused.
//
// Body, optional. The schedule sends none, and moves. {"mode":"report","from":...,"to":...} reads
// a window of up to 7 days and moves nothing, to see what the check would do. A move run never takes
// a window: the chain decides it, so nothing can open a gap in it.
// ---------------------------------------------------------------------------

const Body = z
  .object({
    mode: z.enum(['move', 'report']).default('move'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

export async function POST(request: Request) {
  if (!bearerAuthorized(request.headers.get('authorization'), process.env.MRP_CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let raw: unknown = {}
  try {
    const text = await request.text()
    if (text.trim()) raw = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'the body is not JSON' }, { status: 400 })
  }
  const parsed = Body.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: 'unexpected body' }, { status: 400 })
  const { mode, from, to } = parsed.data

  if (mode === 'move' && (from || to)) {
    return NextResponse.json({ error: 'a move run takes no window' }, { status: 400 })
  }
  const toDate = to ? new Date(to) : new Date()
  const fromDate = from ? new Date(from) : undefined
  if (fromDate && fromDate.getTime() >= toDate.getTime()) {
    return NextResponse.json({ error: 'the window ends before it starts' }, { status: 400 })
  }
  if (fromDate && toDate.getTime() - fromDate.getTime() > MAX_WINDOW_MS) {
    return NextResponse.json({ error: 'a report reads 7 days at most' }, { status: 400 })
  }

  try {
    const summary = await runQuoteSentCheck(
      {
        hubspot: hubspotQuoteSentPort,
        store: supabaseQuoteSentStore(),
        now: () => new Date(),
        writesDisabled: externalCallsDisabled(),
      },
      { mode, from: fromDate, to: to ? toDate : undefined },
    )
    // The board, the banner and every Quotes tab show the stage.
    if (summary.moved.length > 0) revalidatePath('/quotes', 'layout')
    return NextResponse.json(summary)
  } catch (e) {
    console.error('quote-sent check failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'check failed' }, { status: 500 })
  }
}
