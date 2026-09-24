import { describe, it, expect, vi } from 'vitest'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import {
  FIRST_RUN_MS,
  MAX_WINDOW_MS,
  OVERLAP_MS,
  runQuoteSentCheck,
  type QuoteSentHubSpot,
  type QuoteSentMode,
  type QuoteSentMoveRow,
  type QuoteSentStore,
} from '@/lib/quote-sent/run'
import type { DealFacts, EmailFacts, Pipeline, QuoteFacts } from '@/lib/quote-sent/rule'

/**
 * One run of the quote-sent check, with HubSpot and the database faked. Nothing here reaches either.
 * Every id, link and address is invented.
 */

const USA = HUBSPOT_PIPELINES.USA_SALES
const S = USA.stages
const pipeline: Pipeline = {
  id: USA.id,
  stages: [
    { id: S.QUOTE_REQUEST, displayOrder: 0, isClosed: false },
    { id: S.CALL, displayOrder: 1, isClosed: false },
    { id: S.QUOTATION_SENT, displayOrder: 2, isClosed: false },
    { id: S.CLOSED_LOST, displayOrder: 3, isClosed: true },
    { id: S.CLOSED_WON, displayOrder: 4, isClosed: true },
  ],
}
const NOW = new Date('2026-09-24T18:00:00Z')
const LINK = 'https://quotes.example.com/zz98-yy76'

const deal = (over: Partial<DealFacts> = {}): DealFacts => ({
  id: 'd-1',
  pipelineId: USA.id,
  stageId: S.QUOTE_REQUEST,
  isClosed: false,
  stageHistory: [{ stageId: S.QUOTE_REQUEST, at: '2026-09-10T08:00:00Z' }],
  ...over,
})
const quote: QuoteFacts = { id: 'q-1', link: LINK, createdAt: '2026-09-24T16:00:00Z' }
const email: EmailFacts = {
  id: 'e-1',
  direction: 'EMAIL',
  sentAt: '2026-09-24T17:40:00Z',
  body: `Your quote is here: ${LINK}`,
  recipients: ['buyer@customer.example'],
}

function setup(over: { hubspot?: Partial<QuoteSentHubSpot>; lastEnd?: Date | null; writesDisabled?: boolean } = {}) {
  const rows: QuoteSentMoveRow[] = []
  const runs: { mode: QuoteSentMode; from: Date; to: Date; result?: Parameters<QuoteSentStore['finishRun']>[1] }[] = []
  const hubspot: QuoteSentHubSpot = {
    pipelines: vi.fn(async () => [pipeline]),
    outgoingEmailIds: vi.fn(async () => ['e-1']),
    dealIdsForEmails: vi.fn(async () => new Map([['e-1', ['d-1']]])),
    readDeals: vi.fn(async () => [deal()]),
    quotesForDeals: vi.fn(async () => new Map([['d-1', [quote]]])),
    readEmails: vi.fn(async () => [email]),
    userEmails: vi.fn(async () => new Set(['rep@echobarrier.com'])),
    readDeal: vi.fn(async () => deal()),
    moveDeal: vi.fn(async () => {}),
    ...over.hubspot,
  }
  const store: QuoteSentStore = {
    lastCleanMoveRunEnd: vi.fn(async () => (over.lastEnd === undefined ? new Date('2026-09-24T17:30:00Z') : over.lastEnd)),
    startRun: vi.fn(async (r) => {
      runs.push({ ...r })
      return runs.length
    }),
    record: vi.fn(async (r) => {
      rows.push(r)
    }),
    finishRun: vi.fn(async (id, result) => {
      runs[id - 1].result = result
    }),
  }
  const deps = { hubspot, store, now: () => NOW, writesDisabled: over.writesDisabled ?? false }
  return { deps, hubspot, store, rows, runs }
}

describe('runQuoteSentCheck', () => {
  it('moves the deal, records why, and chains its window on the last clean run', async () => {
    const { deps, hubspot, rows, runs } = setup()
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })

    expect(hubspot.moveDeal).toHaveBeenCalledWith('d-1', S.QUOTATION_SENT)
    expect(summary.moved).toEqual([{ dealId: 'd-1', emailSentAt: '2026-09-24T17:40:00Z' }])
    expect(rows).toEqual([
      expect.objectContaining({ dealId: 'd-1', fromStage: S.QUOTE_REQUEST, toStage: S.QUOTATION_SENT, quoteId: 'q-1', emailId: 'e-1', outcome: 'moved' }),
    ])
    expect(runs[0].mode).toBe('move')
    expect(runs[0].from.getTime()).toBe(new Date('2026-09-24T17:30:00Z').getTime() - OVERLAP_MS)
    expect(runs[0].to).toEqual(NOW)
    expect(runs[0].result).toMatchObject({ moved: 1, failed: 0, error: null })
  })

  it('looks back one hour on its very first run, so older sends are left for Dean to decide', async () => {
    const { deps, runs } = setup({ lastEnd: null })
    await runQuoteSentCheck(deps, { mode: 'move' })
    expect(runs[0].from.getTime()).toBe(NOW.getTime() - FIRST_RUN_MS)
  })

  it('caps a window that grew past 7 days and says so', async () => {
    const { deps, runs } = setup({ lastEnd: new Date('2026-08-01T00:00:00Z') })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(runs[0].from.getTime()).toBe(NOW.getTime() - MAX_WINDOW_MS)
    expect(summary.notes).toContain('window capped at 7 days')
  })

  it('in a report run, decides the same way and moves nothing', async () => {
    const { deps, hubspot, store, rows } = setup()
    const from = new Date('2026-09-24T12:00:00Z')
    const summary = await runQuoteSentCheck(deps, { mode: 'report', from, to: NOW })
    expect(hubspot.moveDeal).not.toHaveBeenCalled()
    expect(store.lastCleanMoveRunEnd).not.toHaveBeenCalled()
    expect(summary.wouldMove).toEqual([{ dealId: 'd-1', pipelineId: USA.id, emailSentAt: '2026-09-24T17:40:00Z' }])
    expect(rows[0].outcome).toBe('would_move')
  })

  it('on staging, reports instead of moving, and never counts as a link in the chain', async () => {
    const { deps, hubspot, runs, rows } = setup({ writesDisabled: true })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(hubspot.moveDeal).not.toHaveBeenCalled()
    expect(runs[0].mode).toBe('report')
    expect(rows[0].outcome).toBe('would_move')
    expect(summary.notes).toContain('staging: nothing was moved')
  })

  it('leaves a deal a rep moved while the run was reading', async () => {
    const { deps, hubspot, rows } = setup({
      hubspot: { readDeal: vi.fn(async () => deal({ stageId: S.QUOTATION_SENT })) },
    })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(hubspot.moveDeal).not.toHaveBeenCalled()
    expect(summary.stageChanged).toBe(1)
    expect(rows[0]).toMatchObject({ outcome: 'stage_changed', fromStage: S.QUOTATION_SENT })
  })

  it('records a stage change HubSpot refused and carries on', async () => {
    const { deps, rows, runs } = setup({
      hubspot: {
        moveDeal: vi.fn(async () => {
          throw new Error('HubSpot refused the stage change: HTTP 400')
        }),
      },
    })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(summary.failed).toBe(1)
    expect(rows[0]).toMatchObject({ outcome: 'failed', error: 'HubSpot refused the stage change: HTTP 400' })
    expect(runs[0].result).toMatchObject({ failed: 1, error: null })
  })

  it('does not look up quotes for deals that are closed or already past Quotation sent', async () => {
    const { deps, hubspot } = setup({
      hubspot: {
        readDeals: vi.fn(async () => [deal({ stageId: S.QUOTATION_SENT }), deal({ id: 'd-2', stageId: S.CLOSED_WON, isClosed: true })]),
      },
    })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(summary.candidates).toBe(0)
    expect(hubspot.quotesForDeals).not.toHaveBeenCalled()
    expect(hubspot.moveDeal).not.toHaveBeenCalled()
  })

  it('stops early on a quiet half hour', async () => {
    const { deps, hubspot, runs } = setup({ hubspot: { outgoingEmailIds: vi.fn(async () => []) } })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(summary.emailsRead).toBe(0)
    expect(hubspot.dealIdsForEmails).not.toHaveBeenCalled()
    expect(runs[0].result).toMatchObject({ error: null })
  })

  it('counts why candidates stayed, for the report', async () => {
    const { deps } = setup({ hubspot: { readEmails: vi.fn(async () => [{ ...email, direction: 'INCOMING_EMAIL' }]) } })
    const summary = await runQuoteSentCheck(deps, { mode: 'move' })
    expect(summary.moved).toEqual([])
    expect(summary.skipped).toEqual({ link_only_received: 1 })
  })

  it('finishes a run HubSpot broke with the error, so the next run starts from the last clean one', async () => {
    const { deps, runs } = setup({
      hubspot: {
        outgoingEmailIds: vi.fn(async () => {
          throw new Error('HubSpot email search: HTTP 502')
        }),
      },
    })
    await expect(runQuoteSentCheck(deps, { mode: 'move' })).rejects.toThrow('HTTP 502')
    expect(runs[0].result).toMatchObject({ error: 'HubSpot email search: HTTP 502' })
  })

  it('a backfill needs a window, moves, and stays out of the chain', async () => {
    const first = setup()
    await expect(runQuoteSentCheck(first.deps, { mode: 'backfill' })).rejects.toThrow('a backfill run needs a window')

    const { deps, store, hubspot, runs } = setup()
    const from = new Date('2026-06-01T00:00:00Z')
    await runQuoteSentCheck(deps, { mode: 'backfill', from, to: NOW })
    expect(store.lastCleanMoveRunEnd).not.toHaveBeenCalled()
    expect(runs[0]).toMatchObject({ mode: 'backfill', from })
    expect(hubspot.moveDeal).toHaveBeenCalledTimes(1)
  })
})
