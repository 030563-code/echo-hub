import { automaticSentStageFor } from './stage'
import { decide, stagesBeforeSent, type DealFacts, type EmailFacts, type Pipeline, type QuoteFacts, type SkipReason } from './rule'

/**
 * One run of the quote-sent check: read the outgoing emails HubSpot logged in a window, find the
 * open deals they sit on, and move each deal whose quote link one of them carries to Quotation sent.
 *
 * n8n runs it every half hour (POST /api/quotes/detect-sent). Each scheduled run starts where the
 * last clean one ended, less an hour, so a run that fails or never happens loses nothing, and an
 * email HubSpot logs or indexes late is still caught. Reading only what was logged since the last
 * run keeps a run to a handful of emails (about 44 outgoing a day across the company on 24 Sep
 * 2026), well inside a function's time limit.
 *
 * The first scheduled run looks back one hour only, so deals whose quote went out before the check
 * existed are left alone: moving that backlog is Dean's call, and would be a 'backfill' run.
 *
 * A report run reads and decides the same way and moves nothing. Staging always reports.
 * Deals only ever move forward, and each is read again just before it moves.
 */

export type QuoteSentMode = 'move' | 'report' | 'backfill'

/** How far back each scheduled run reaches past the end of the last one. */
export const OVERLAP_MS = 60 * 60 * 1000
/** How far back the very first scheduled run looks. */
export const FIRST_RUN_MS = 60 * 60 * 1000
/** How far back a scheduled run ever reaches, and the longest window a report may ask for. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The most one scheduled run reads when it is catching up. A full 7 days took 7.7 seconds on the
 * live site on 24 Sep 2026, close to a function's time limit, and a run cut off there would start
 * again from the same place every half hour. Twelve hours at a time always finishes, and each run
 * moves the chain on, so an outage of days is caught up within a few hours.
 */
export const MAX_STEP_MS = 12 * 60 * 60 * 1000

export interface QuoteSentHubSpot {
  pipelines(): Promise<Pipeline[]>
  /** Ids of the outgoing emails HubSpot logged (created) in [fromMs, toMs). */
  outgoingEmailIds(fromMs: number, toMs: number): Promise<string[]>
  /** Email id to the deals it is attached to. */
  dealIdsForEmails(emailIds: string[]): Promise<Map<string, string[]>>
  readDeals(dealIds: string[]): Promise<DealFacts[]>
  quotesForDeals(dealIds: string[]): Promise<Map<string, QuoteFacts[]>>
  readEmails(emailIds: string[]): Promise<EmailFacts[]>
  /** Every address a HubSpot user signs in with, so mail between colleagues never counts. */
  userEmails(): Promise<Set<string>>
  /** The deal as it stands now, read again just before a move. */
  readDeal(dealId: string): Promise<DealFacts | null>
  /** dealstage only. */
  moveDeal(dealId: string, stageId: string): Promise<void>
}

export interface QuoteSentMoveRow {
  runId: number
  dealId: string
  pipelineId: string
  fromStage: string
  toStage: string
  quoteId: string
  emailId: string
  emailSentAt: string
  outcome: 'moved' | 'would_move' | 'failed' | 'stage_changed'
  error?: string | null
}

export interface QuoteSentStore {
  /** Where the newest clean scheduled run's window ended. */
  lastCleanMoveRunEnd(): Promise<Date | null>
  startRun(run: { mode: QuoteSentMode; from: Date; to: Date }): Promise<number>
  record(row: QuoteSentMoveRow): Promise<void>
  finishRun(
    runId: number,
    result: {
      emailsRead: number
      dealsChecked: number
      moved: number
      wouldMove: number
      failed: number
      notes: string[]
      error: string | null
    },
  ): Promise<void>
}

export interface QuoteSentRunSummary {
  runId: number
  mode: QuoteSentMode
  windowFrom: string
  windowTo: string
  emailsRead: number
  /** Deals the logged emails sit on. */
  dealsChecked: number
  /** Of those, open deals before Quotation sent. */
  candidates: number
  moved: { dealId: string; emailSentAt: string }[]
  wouldMove: { dealId: string; pipelineId: string; emailSentAt: string }[]
  failed: number
  stageChanged: number
  skipped: Partial<Record<SkipReason, number>>
  notes: string[]
}

export interface QuoteSentDeps {
  hubspot: QuoteSentHubSpot
  store: QuoteSentStore
  now: () => Date
  /** externalCallsDisabled(): staging reports instead of moving. */
  writesDisabled: boolean
}

function eligible(deal: DealFacts, pipeline: Pipeline | undefined): string | null {
  const sent = automaticSentStageFor(deal.pipelineId)
  if (!sent || !pipeline || deal.isClosed) return null
  return stagesBeforeSent(pipeline, sent).includes(deal.stageId) ? sent : null
}

export async function runQuoteSentCheck(
  deps: QuoteSentDeps,
  opts: { mode: QuoteSentMode; from?: Date; to?: Date },
): Promise<QuoteSentRunSummary> {
  const notes: string[] = []
  let mode = opts.mode
  if (mode !== 'report' && deps.writesDisabled) {
    mode = 'report'
    notes.push('staging: nothing was moved')
  }
  if (opts.mode === 'backfill' && !opts.from) throw new Error('a backfill run needs a window')

  let to = opts.to ?? deps.now()
  let from = opts.from ?? null
  const chained = !from
  if (!from) {
    const last = opts.mode === 'move' ? await deps.store.lastCleanMoveRunEnd() : null
    from = last ? new Date(last.getTime() - OVERLAP_MS) : new Date(to.getTime() - FIRST_RUN_MS)
  }
  if (opts.mode !== 'backfill' && to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    from = new Date(to.getTime() - MAX_WINDOW_MS)
    notes.push('window capped at 7 days')
  }
  // A scheduled run that is behind reads the oldest twelve hours and leaves the rest to the next.
  if (chained && opts.mode === 'move' && to.getTime() - from.getTime() > MAX_STEP_MS) {
    to = new Date(from.getTime() + MAX_STEP_MS)
    notes.push('catching up: read 12 hours, the next run reads on')
  }
  if (from.getTime() >= to.getTime()) throw new Error('the window ends before it starts')

  // Recorded as what it did, so a staging run is a report. The schedule's chain reads clean move
  // runs only, so neither a report nor a backfill ever shifts it.
  const runId = await deps.store.startRun({ mode, from, to })
  const summary: QuoteSentRunSummary = {
    runId,
    mode,
    windowFrom: from.toISOString(),
    windowTo: to.toISOString(),
    emailsRead: 0,
    dealsChecked: 0,
    candidates: 0,
    moved: [],
    wouldMove: [],
    failed: 0,
    stageChanged: 0,
    skipped: {},
    notes,
  }
  const finish = (error: string | null) =>
    deps.store.finishRun(runId, {
      emailsRead: summary.emailsRead,
      dealsChecked: summary.dealsChecked,
      moved: summary.moved.length,
      wouldMove: summary.wouldMove.length,
      failed: summary.failed,
      notes,
      error,
    })

  try {
    const emailIds = await deps.hubspot.outgoingEmailIds(from.getTime(), to.getTime())
    summary.emailsRead = emailIds.length

    const emailsByDeal = new Map<string, string[]>()
    if (emailIds.length > 0) {
      for (const [emailId, dealIds] of await deps.hubspot.dealIdsForEmails(emailIds)) {
        for (const dealId of dealIds) emailsByDeal.set(dealId, [...(emailsByDeal.get(dealId) ?? []), emailId])
      }
    }
    const deals = emailsByDeal.size > 0 ? await deps.hubspot.readDeals([...emailsByDeal.keys()]) : []
    summary.dealsChecked = deals.length

    const pipelines = new Map((deals.length > 0 ? await deps.hubspot.pipelines() : []).map((p) => [p.id, p]))
    // Only an open deal before Quotation sent is worth a look at its quotes.
    const candidates = deals.filter((d) => eligible(d, pipelines.get(d.pipelineId)))
    summary.candidates = candidates.length

    const quotes = candidates.length > 0 ? await deps.hubspot.quotesForDeals(candidates.map((d) => d.id)) : new Map()
    const withLinks = candidates.filter((d) => (quotes.get(d.id) ?? []).some((q: QuoteFacts) => q.link))
    const bodiesNeeded = [...new Set(withLinks.flatMap((d) => emailsByDeal.get(d.id) ?? []))]
    const emails = new Map((bodiesNeeded.length > 0 ? await deps.hubspot.readEmails(bodiesNeeded) : []).map((e) => [e.id, e]))
    const userEmails = withLinks.length > 0 ? await deps.hubspot.userEmails() : new Set<string>()

    for (const deal of candidates) {
      const pipeline = pipelines.get(deal.pipelineId)
      const decision = decide({
        deal,
        pipeline,
        sentStageId: automaticSentStageFor(deal.pipelineId),
        quotes: quotes.get(deal.id) ?? [],
        emails: (emailsByDeal.get(deal.id) ?? []).map((id) => emails.get(id)).filter((e): e is EmailFacts => !!e),
        userEmails,
      })
      if (!decision.move) {
        summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1
        continue
      }
      const row = {
        runId,
        dealId: deal.id,
        pipelineId: deal.pipelineId,
        fromStage: deal.stageId,
        toStage: decision.toStageId,
        quoteId: decision.quoteId,
        emailId: decision.emailId,
        emailSentAt: decision.emailSentAt,
      }

      if (mode === 'report') {
        await deps.store.record({ ...row, outcome: 'would_move' })
        summary.wouldMove.push({ dealId: deal.id, pipelineId: deal.pipelineId, emailSentAt: decision.emailSentAt })
        continue
      }

      // Read again: a rep may have moved it, or closed it, while this run was reading.
      const current = await deps.hubspot.readDeal(deal.id)
      if (!current || current.pipelineId !== deal.pipelineId || eligible(current, pipeline) !== decision.toStageId) {
        await deps.store.record({ ...row, fromStage: current?.stageId ?? deal.stageId, outcome: 'stage_changed' })
        summary.stageChanged += 1
        continue
      }
      try {
        await deps.hubspot.moveDeal(deal.id, decision.toStageId)
        await deps.store.record({ ...row, fromStage: current.stageId, outcome: 'moved' })
        summary.moved.push({ dealId: deal.id, emailSentAt: decision.emailSentAt })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await deps.store.record({ ...row, fromStage: current.stageId, outcome: 'failed', error: message })
        summary.failed += 1
      }
    }

    await finish(null)
    return summary
  } catch (err) {
    await finish(err instanceof Error ? err.message : String(err))
    throw err
  }
}
