import { describe, it, expect } from 'vitest'
import {
  EMPTY_DEAL_FILTERS,
  HUBSPOT_MAX_FILTERS_PER_GROUP,
  buildDealFilterGroup,
  parseBoardDealFilters,
  parseStageQueueDealFilters,
  activeDealFilterCount,
  dealFiltersToHubSpot,
  dealFiltersToQuery,
  parseDealFilters,
  type DealFilters,
} from '@/lib/deal-filters'

const filters = (over: Partial<DealFilters> = {}): DealFilters => ({ ...EMPTY_DEAL_FILTERS, ...over })

describe('parseDealFilters', () => {
  it('reads every field off a searchParams object', () => {
    expect(
      parseDealFilters({
        q: 'acme',
        pipeline: 'p1',
        stages: 'a,b',
        owner: '77',
        depot: 'US California',
        amountMin: '100',
        amountMax: '900',
        createdFrom: '2026-08-01',
        createdTo: '2026-08-31',
      }),
    ).toEqual({
      q: 'acme',
      pipelineId: 'p1',
      stages: ['a', 'b'],
      ownerId: '77',
      depot: 'US California',
      amountMin: '100',
      amountMax: '900',
      createdFrom: '2026-08-01',
      createdTo: '2026-08-31',
    })
  })

  it('accepts stages repeated as well as comma-joined', () => {
    // Which shape arrives depends on how the form serialised, so both are read
    // rather than trusting one.
    expect(parseDealFilters({ stages: ['a', 'b'] }).stages).toEqual(['a', 'b'])
    expect(parseDealFilters({ stages: 'a, b ,' }).stages).toEqual(['a', 'b'])
  })

  it('gives empty filters for an empty query string', () => {
    expect(parseDealFilters({})).toEqual(EMPTY_DEAL_FILTERS)
  })
})

describe('parseBoardDealFilters', () => {
  it('never carries a pipeline, however the URL spells it', () => {
    // The board owns the `pipeline` parameter for its own selector. If it were
    // also a filter, the selector's form would hold two fields of that name,
    // the parameter would submit twice, arrive as an array, and the board would
    // fall back to the profile pipeline. That looked like choosing USA SALES
    // and bouncing straight back to UK SALES - NEW.
    expect(parseBoardDealFilters({ pipeline: 'usa-sales-id' }).pipelineId).toBe('')
    expect(parseBoardDealFilters({ pipeline: ['a', 'b'] }).pipelineId).toBe('')
  })

  it('keeps every other filter intact', () => {
    const parsed = parseBoardDealFilters({ pipeline: 'usa', q: 'acme', depot: 'US California' })
    expect(parsed.q).toBe('acme')
    expect(parsed.depot).toBe('US California')
  })
})

describe('parseStageQueueDealFilters', () => {
  it('never carries a stage', () => {
    // Deals, Sent, Accepted and Won each pin `dealstage IN <family>` for their
    // own category. A stage carried over from the board would AND with that
    // family and empty the tab.
    expect(parseStageQueueDealFilters({ stages: 'quotation-sent-id' }).stages).toEqual([])
    expect(parseStageQueueDealFilters({ stages: ['a', 'b'] }).stages).toEqual([])
  })

  it('keeps the filters that do not collide with the category', () => {
    const parsed = parseStageQueueDealFilters({
      stages: 'x',
      pipeline: 'usa',
      q: 'acme',
      depot: 'US California',
      amountMin: '100',
    })
    expect(parsed.pipelineId).toBe('usa')
    expect(parsed.q).toBe('acme')
    expect(parsed.depot).toBe('US California')
    expect(parsed.amountMin).toBe('100')
  })
})

describe('dealFiltersToHubSpot', () => {
  it('sends nothing at all when nothing is set', () => {
    // Load-bearing: HubSpot rejects a filter with an empty value, so one stray
    // blank would fail the whole board rather than widen it.
    expect(dealFiltersToHubSpot(EMPTY_DEAL_FILTERS)).toEqual([])
  })

  it('wildcards a name search so a half-typed name still matches', () => {
    // CONTAINS_TOKEN is token-based: without the trailing star, "acme" does not
    // match "Acme Corporation".
    expect(dealFiltersToHubSpot(filters({ q: 'acme' }))).toEqual([
      { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: 'acme*' },
    ])
  })

  it('does not double the wildcard the user typed', () => {
    expect(dealFiltersToHubSpot(filters({ q: 'acme*' }))[0].value).toBe('acme*')
  })

  it('uses IN for stages and EQ for pipeline, owner and depot', () => {
    expect(
      dealFiltersToHubSpot(
        filters({ pipelineId: 'p1', stages: ['s1', 's2'], ownerId: '77', depot: 'US Baltimore' }),
      ),
    ).toEqual([
      { propertyName: 'pipeline', operator: 'EQ', value: 'p1' },
      { propertyName: 'dealstage', operator: 'IN', values: ['s1', 's2'] },
      { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '77' },
      // The long name, not the code: sending_depot's internal value is
      // "US Baltimore" and its HubSpot display label is "US-BAL".
      { propertyName: 'sending_depot', operator: 'EQ', value: 'US Baltimore' },
    ])
  })

  // Both ends set collapses to ONE filter, not two. That is what keeps a
  // fully-filtered view inside HubSpot's six-per-group cap. BETWEEN was
  // verified live on 2026-09-03 to be inclusive at both ends.
  it('bounds the amount at both ends as a single BETWEEN', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: '100', amountMax: '2500' }))).toEqual([
      { propertyName: 'amount', operator: 'BETWEEN', value: '100', highValue: '2500' },
    ])
  })

  it('falls back to a one-sided operator when only one end is set', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: '100' }))).toEqual([
      { propertyName: 'amount', operator: 'GTE', value: '100' },
    ])
    expect(dealFiltersToHubSpot(filters({ amountMax: '2500' }))).toEqual([
      { propertyName: 'amount', operator: 'LTE', value: '2500' },
    ])
  })

  it('drops an amount that is not a number instead of sending it', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: 'abc' }))).toEqual([])
  })

  // An unparseable half must not silently turn a range into the other half's
  // one-sided filter, which would widen the search rather than narrow it.
  it('keeps the valid half when the other half is junk', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: 'abc', amountMax: '2500' }))).toEqual([
      { propertyName: 'amount', operator: 'LTE', value: '2500' },
    ])
  })

  it('converts dates to epoch milliseconds, with the to-date covering its whole day', () => {
    const out = dealFiltersToHubSpot(filters({ createdFrom: '2026-08-01', createdTo: '2026-08-31' }))
    expect(out).toEqual([
      {
        propertyName: 'createdate',
        operator: 'BETWEEN',
        value: String(Date.parse('2026-08-01T00:00:00.000Z')),
        highValue: String(Date.parse('2026-08-31T23:59:59.999Z')),
      },
    ])
    // The whole point of end-of-day: a deal created during 31 August is inside
    // the range, not excluded by an off-by-one that reads as missing data.
    expect(Number(out[0].highValue)).toBeGreaterThan(Date.parse('2026-08-31T12:00:00.000Z'))
  })

  it('uses a one-sided date operator when only one end is set', () => {
    expect(dealFiltersToHubSpot(filters({ createdFrom: '2026-08-01' }))).toEqual([
      { propertyName: 'createdate', operator: 'GTE', value: String(Date.parse('2026-08-01T00:00:00.000Z')) },
    ])
  })

  it('ignores a malformed date rather than sending garbage', () => {
    expect(dealFiltersToHubSpot(filters({ createdFrom: '31/08/2026' }))).toEqual([])
    expect(dealFiltersToHubSpot(filters({ createdFrom: '2026-13-45' }))).toEqual([])
  })
})

describe('activeDealFilterCount', () => {
  it('counts only what the user actually set', () => {
    expect(activeDealFilterCount(EMPTY_DEAL_FILTERS)).toBe(0)
    expect(activeDealFilterCount(filters({ q: 'acme', stages: ['s1'], amountMin: '10' }))).toBe(3)
    expect(activeDealFilterCount(filters({ q: '   ' }))).toBe(0)
  })
})

describe('dealFiltersToQuery', () => {
  it('omits every empty field so a shared link carries only what was set', () => {
    expect(dealFiltersToQuery(filters({ q: 'acme', stages: ['s1', 's2'] }))).toEqual({
      q: 'acme',
      stages: 's1,s2',
    })
  })

  it('round-trips back through the parser', () => {
    const original = filters({
      q: 'acme',
      pipelineId: 'p1',
      stages: ['s1', 's2'],
      ownerId: '77',
      depot: 'US California',
      amountMin: '100',
      amountMax: '900',
      createdFrom: '2026-08-01',
      createdTo: '2026-08-31',
    })
    expect(parseDealFilters(dealFiltersToQuery(original))).toEqual(original)
  })
})

/**
 * HubSpot caps one filterGroup at six filters and returns a 400 on the
 * seventh: "too many filters per filter group (count: 7, max allowed: 6)",
 * verified live on 2026-09-03. Groups are OR'd, so a longer AND cannot be
 * split across them.
 *
 * Every deal surface pins some of that budget server-side, so the number a rep
 * may set differs per page. Before the guard the seventh filter reached
 * HubSpot and came back as "Failed to fetch deals from HubSpot", which reads
 * as an outage rather than as something the rep can fix.
 */
describe('buildDealFilterGroup', () => {
  const pinned = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ propertyName: `pinned${i}`, operator: 'EQ', value: 'x' }))

  it('passes the pinned filters through ahead of the rep\'s', () => {
    const result = buildDealFilterGroup(pinned(1), filters({ q: 'acme' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filters).toEqual([
      { propertyName: 'pinned0', operator: 'EQ', value: 'x' },
      { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: 'acme*' },
    ])
  })

  it('allows exactly the cap', () => {
    const result = buildDealFilterGroup(
      pinned(2),
      filters({ q: 'a', depot: 'US Baltimore', amountMin: '1', amountMax: '2', createdFrom: '2026-08-01', createdTo: '2026-08-31' }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 2 pinned + name + depot + one amount BETWEEN + one createdate BETWEEN.
    expect(result.filters).toHaveLength(HUBSPOT_MAX_FILTERS_PER_GROUP)
  })

  it('refuses one over the cap, naming what to clear and how many', () => {
    const result = buildDealFilterGroup(
      pinned(3),
      filters({ q: 'a', pipelineId: 'p', depot: 'US Baltimore', amountMin: '1' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Clear 1 of')
    expect(result.error).toContain('deal name')
    expect(result.error).toContain('depot')
    expect(result.error).toContain('amount')
  })

  // The board pins pipeline + recency window + owner, so a rep there has three
  // left. This is the case that broke in the shipped build.
  it('lets a board rep set three filters but not four', () => {
    const boardPinned = pinned(3)
    const three = filters({ q: 'a', depot: 'US Baltimore', amountMin: '1', amountMax: '9' })
    expect(buildDealFilterGroup(boardPinned, three).ok).toBe(true)

    const four = filters({ ...three, createdFrom: '2026-08-01', createdTo: '2026-08-31' })
    expect(buildDealFilterGroup(boardPinned, four).ok).toBe(false)
  })

  it('never reports an empty filter list as over the cap', () => {
    expect(buildDealFilterGroup(pinned(6), EMPTY_DEAL_FILTERS).ok).toBe(true)
  })
})
