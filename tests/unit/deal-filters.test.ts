import { describe, it, expect } from 'vitest'
import {
  EMPTY_DEAL_FILTERS,
  parseBoardDealFilters,
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

  it('bounds the amount at both ends', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: '100', amountMax: '2500' }))).toEqual([
      { propertyName: 'amount', operator: 'GTE', value: '100' },
      { propertyName: 'amount', operator: 'LTE', value: '2500' },
    ])
  })

  it('drops an amount that is not a number instead of sending it', () => {
    expect(dealFiltersToHubSpot(filters({ amountMin: 'abc' }))).toEqual([])
  })

  it('converts dates to epoch milliseconds, with the to-date covering its whole day', () => {
    const out = dealFiltersToHubSpot(filters({ createdFrom: '2026-08-01', createdTo: '2026-08-31' }))
    expect(out).toEqual([
      { propertyName: 'createdate', operator: 'GTE', value: String(Date.parse('2026-08-01T00:00:00.000Z')) },
      { propertyName: 'createdate', operator: 'LTE', value: String(Date.parse('2026-08-31T23:59:59.999Z')) },
    ])
    // The whole point of end-of-day: a deal created during 31 August is inside
    // the range, not excluded by an off-by-one that reads as missing data.
    expect(Number(out[1].value)).toBeGreaterThan(Date.parse('2026-08-31T12:00:00.000Z'))
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
