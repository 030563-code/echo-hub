import { describe, it, expect } from 'vitest'
import { boardColumns, closedLostStageFor, groupDealsByStage, isClosedStage } from '@/lib/deals-board'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

const USA = HUBSPOT_PIPELINES.USA_SALES.id
const S = HUBSPOT_PIPELINES.USA_SALES.stages
const deal = (id: string, dealstage: string) => ({ id, properties: { dealstage } })

describe('boardColumns', () => {
  it("gives USA SALES its eleven stages in Dean's funnel order, verbatim", () => {
    // The labels are HubSpot's, verbatim, checked live on 2026-09-02. The ORDER
    // is Dean's, set on 2026-09-03, and deliberately not HubSpot displayOrder,
    // which interleaves the closed and distributor stages with the live ones.
    // Call is last because it is absent from his list, not because it was
    // dropped: it keeps a column so Call deals stay visible.
    expect(boardColumns(USA).map((c) => c.label)).toEqual([
      'Quote Request',
      'General pricing',
      'Quotation sent',
      'Quotation Accepted',
      'Closed won',
      'Closed lost',
      'Passed to Distributor',
      'Closed Won by Distributor',
      'Closed Lost By Distributor',
      'Tender',
      'Call',
    ])
  })

  it('leaves every other pipeline on HubSpot displayOrder', () => {
    // The custom order is scoped to USA SALES by pipeline id. A pipeline that
    // happens to share key names must not get half of Dean's order applied.
    const uk = HUBSPOT_PIPELINES.UK_SALES
    expect(boardColumns(uk.id).map((c) => c.stageKey)).toEqual(Object.keys(uk.stages))
  })

  it('carries the stage id and its key so a column can be styled by family', () => {
    const [first] = boardColumns(USA)
    expect(first).toEqual({ stageId: S.QUOTE_REQUEST, stageKey: 'QUOTE_REQUEST', label: 'Quote Request' })
  })

  it('returns nothing for an unknown pipeline rather than guessing another region', () => {
    expect(boardColumns('not-a-pipeline')).toEqual([])
    expect(boardColumns(null)).toEqual([])
    expect(boardColumns('')).toEqual([])
  })
})

describe('groupDealsByStage', () => {
  const columns = boardColumns(USA)

  it('buckets each deal under its own stage and keeps the incoming order', () => {
    const deals = [deal('1', S.QUOTE_REQUEST), deal('2', S.TENDER), deal('3', S.QUOTE_REQUEST)]
    const groups = groupDealsByStage(deals, columns)
    expect(groups.find((g) => g.column.stageKey === 'QUOTE_REQUEST')?.deals.map((d) => d.id)).toEqual(['1', '3'])
    expect(groups.find((g) => g.column.stageKey === 'TENDER')?.deals.map((d) => d.id)).toEqual(['2'])
  })

  it('returns every column, and NO Other column, when there is nothing to place', () => {
    const groups = groupDealsByStage([], columns)
    expect(groups).toHaveLength(columns.length)
    expect(groups.every((g) => g.deals.length === 0)).toBe(true)
  })

  it('never drops a deal whose stage belongs to another pipeline', () => {
    // Real case: someone moves a deal between pipelines in HubSpot between the
    // search and the render. A board that quietly dropped it would have a rep
    // hunting for a deal the Hub had decided not to mention.
    const stray = deal('9', HUBSPOT_PIPELINES.EURO_SALES.stages.CLOSED_WON)
    const groups = groupDealsByStage([deal('1', S.CALL), stray], columns)
    const other = groups[groups.length - 1]
    expect(other.column.label).toBe('Other')
    expect(other.column.stageId).toBe('')
    expect(other.deals.map((d) => d.id)).toEqual(['9'])
  })

  it('puts a deal with no stage at all into Other rather than a random column', () => {
    const groups = groupDealsByStage([deal('1', '')], columns)
    expect(groups[groups.length - 1].deals.map((d) => d.id)).toEqual(['1'])
  })
})

describe('isClosedStage', () => {
  it('is true for the ordinary closed stages', () => {
    expect(isClosedStage(S.CLOSED_WON)).toBe(true)
    expect(isClosedStage(S.CLOSED_LOST)).toBe(true)
  })

  it('is true for the two DISTRIBUTOR outcomes, which sit outside the family arrays', () => {
    // Checked in hubspot-constants.ts: CLOSED_WON_STAGES omits
    // CLOSED_WON_DISTRIBUTOR and CLOSED_LOST_STAGES omits its counterpart, so a
    // naive membership test would offer "Assign to contractor" on a finished deal.
    expect(isClosedStage(S.CLOSED_WON_DISTRIBUTOR)).toBe(true)
    expect(isClosedStage(S.CLOSED_LOST_DISTRIBUTOR)).toBe(true)
  })

  it('is false for every stage where work is still open', () => {
    for (const stage of [S.QUOTE_REQUEST, S.CALL, S.QUOTATION_SENT, S.TENDER, S.QUOTATION_ACCEPTED, S.GENERAL_PRICING, S.PASSED_TO_DISTRIBUTOR]) {
      expect(isClosedStage(stage)).toBe(false)
    }
    expect(isClosedStage('')).toBe(false)
    expect(isClosedStage(null)).toBe(false)
  })
})

describe('closedLostStageFor', () => {
  it('resolves the USA and EURO Closed Lost stages', () => {
    expect(closedLostStageFor(USA)).toBe(S.CLOSED_LOST)
    expect(closedLostStageFor(HUBSPOT_PIPELINES.EURO_SALES.id)).toBe(
      HUBSPOT_PIPELINES.EURO_SALES.stages.CLOSED_LOST,
    )
  })

  it('handles the pipelines that spell the key differently', () => {
    expect(closedLostStageFor(HUBSPOT_PIPELINES.UK_SALES_NEW.id)).toBe(
      HUBSPOT_PIPELINES.UK_SALES_NEW.stages.CLOSED_LOST_SALE,
    )
    expect(closedLostStageFor(HUBSPOT_PIPELINES.DEMO_SALES.id)).toBe(
      HUBSPOT_PIPELINES.DEMO_SALES.stages.DEAL_LOST,
    )
  })

  it('returns null rather than guessing for a pipeline with no single candidate', () => {
    // Closing a deal into the wrong stage is not something anyone notices
    // afterwards, so an ambiguous pipeline refuses instead.
    expect(closedLostStageFor(HUBSPOT_PIPELINES.INTER_COMPANY_SALES.id)).toBeNull()
    expect(closedLostStageFor('not-a-pipeline')).toBeNull()
    expect(closedLostStageFor(null)).toBeNull()
  })
})
