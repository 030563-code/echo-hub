import { describe, it, expect } from 'vitest'
import {
  MAX_TRACKING_PER_LINE,
  parseTrackingCategories,
  parseLineTracking,
  toXeroTracking,
  setLineTracking,
  type TrackingCategory,
} from '@/lib/customer-invoice/tracking'

/** Shaped exactly as Xero's GET /TrackingCategories returns, per its OpenAPI
 *  spec: categories carry Options, and both levels carry a Status. */
const XERO_RESPONSE = [
  {
    TrackingCategoryID: 'cat-region',
    Name: 'Region',
    Status: 'ACTIVE',
    Options: [
      { TrackingOptionID: 'opt-east', Name: 'East', Status: 'ACTIVE' },
      { TrackingOptionID: 'opt-west', Name: 'West', Status: 'ACTIVE' },
      { TrackingOptionID: 'opt-old', Name: 'Retired region', Status: 'ARCHIVED' },
    ],
  },
  {
    TrackingCategoryID: 'cat-dept',
    Name: 'Department',
    Status: 'ACTIVE',
    Options: [{ TrackingOptionID: 'opt-sales', Name: 'Sales', Status: 'ACTIVE' }],
  },
  {
    TrackingCategoryID: 'cat-dead',
    Name: 'Old scheme',
    Status: 'ARCHIVED',
    Options: [{ TrackingOptionID: 'opt-x', Name: 'X', Status: 'ACTIVE' }],
  },
]

describe('parseTrackingCategories', () => {
  const parsed = parseTrackingCategories(XERO_RESPONSE)

  it('keeps only ACTIVE categories', () => {
    // Xero keeps archived ones so historical transactions still resolve.
    // Offering one would let a rep tag a NEW invoice with a retired category,
    // which Xero then rejects on the way in rather than at the point of choosing.
    expect(parsed.map((c) => c.name)).toEqual(['Region', 'Department'])
  })

  it('keeps only ACTIVE options within a category', () => {
    expect(parsed[0].options.map((o) => o.name)).toEqual(['East', 'West'])
  })

  it('degrades to nothing rather than throwing on junk', () => {
    expect(parseTrackingCategories(null)).toEqual([])
    expect(parseTrackingCategories({})).toEqual([])
    expect(parseTrackingCategories(['nonsense', 42])).toEqual([])
  })
})

describe('setLineTracking', () => {
  const [region, dept] = parseTrackingCategories(XERO_RESPONSE)

  it('adds a choice', () => {
    expect(setLineTracking([], region, 'opt-east')).toEqual([
      { categoryId: 'cat-region', categoryName: 'Region', optionId: 'opt-east', optionName: 'East' },
    ])
  })

  it('REPLACES the previous choice for the same category', () => {
    // Two options from one category is a payload Xero rejects, so it must be
    // impossible to build rather than merely discouraged.
    const first = setLineTracking([], region, 'opt-east')
    const second = setLineTracking(first, region, 'opt-west')
    expect(second).toHaveLength(1)
    expect(second[0].optionName).toBe('West')
  })

  it('keeps other categories when one changes', () => {
    const both = setLineTracking(setLineTracking([], region, 'opt-east'), dept, 'opt-sales')
    expect(both.map((t) => t.categoryName).sort()).toEqual(['Department', 'Region'])
  })

  it('clears a category when the rep picks blank', () => {
    const both = setLineTracking(setLineTracking([], region, 'opt-east'), dept, 'opt-sales')
    const cleared = setLineTracking(both, region, '')
    expect(cleared.map((t) => t.categoryName)).toEqual(['Department'])
  })

  it('never exceeds the two Xero allows', () => {
    expect(MAX_TRACKING_PER_LINE).toBe(2)
    const third: TrackingCategory = { categoryId: 'c3', name: 'Third', options: [{ optionId: 'o3', name: 'Three' }] }
    const full = setLineTracking(setLineTracking([], region, 'opt-east'), dept, 'opt-sales')
    expect(setLineTracking(full, third, 'o3')).toHaveLength(2)
  })
})

describe('toXeroTracking', () => {
  it('maps to the LineItemTracking shape from Xero\'s spec', () => {
    const tracking = setLineTracking([], parseTrackingCategories(XERO_RESPONSE)[0], 'opt-east')
    expect(toXeroTracking(tracking)).toEqual([
      { TrackingCategoryID: 'cat-region', TrackingOptionID: 'opt-east', Name: 'Region', Option: 'East' },
    ])
  })

  it('sends nothing for an untracked line', () => {
    expect(toXeroTracking([])).toEqual([])
  })
})

describe('parseLineTracking', () => {
  it('reads the stored column back', () => {
    const stored = [{ categoryId: 'c', categoryName: 'Region', optionId: 'o', optionName: 'East' }]
    expect(parseLineTracking(stored)).toEqual(stored)
  })

  it('drops entries missing an id, which cannot be matched in Xero', () => {
    expect(parseLineTracking([{ categoryName: 'Region', optionName: 'East' }])).toEqual([])
  })

  it('survives a column holding something unexpected', () => {
    expect(parseLineTracking(null)).toEqual([])
    expect(parseLineTracking('nope')).toEqual([])
    expect(parseLineTracking([null, 7])).toEqual([])
  })
})
