import { describe, it, expect } from 'vitest'
import { lineItemIdsFromAssociations } from '@/lib/hubspot-associations'

/**
 * The live regression this exists to stop.
 *
 * addLineItemsToDeal archives whatever ids it reads here before writing the
 * replacement set. It only checked `line_item` and `line_items`; HubSpot
 * actually answers `?associations=line_items` with the key `"line items"`, so
 * it archived nothing and appended instead. Deal 64665124513 ended up holding a
 * $100 line and a $1,000 line at once after one recall-and-edit.
 */
describe('lineItemIdsFromAssociations', () => {
  it('reads the spaced key HubSpot actually returns', () => {
    const payload = { 'line items': { results: [{ id: '58610795807' }, { id: '58628086160' }] } }
    expect(lineItemIdsFromAssociations(payload)).toEqual(['58610795807', '58628086160'])
  })

  it('reads the underscored plural the v3 docs show', () => {
    expect(lineItemIdsFromAssociations({ line_items: { results: [{ id: '1' }] } })).toEqual(['1'])
  })

  it('reads the singular older responses used', () => {
    expect(lineItemIdsFromAssociations({ line_item: { results: [{ id: '2' }] } })).toEqual(['2'])
  })

  it('merges every spelling and de-duplicates, so nothing is archived twice', () => {
    const payload = {
      line_items: { results: [{ id: '1' }, { id: '2' }] },
      'line items': { results: [{ id: '2' }, { id: '3' }] },
    }
    expect(lineItemIdsFromAssociations(payload)).toEqual(['1', '2', '3'])
  })

  it('returns nothing for a deal with no line items', () => {
    expect(lineItemIdsFromAssociations({ companies: { results: [{ id: '9' }] } })).toEqual([])
  })

  // A missing or malformed payload must read as "none", never throw: the caller
  // is mid-way through a Generate and a crash here loses the quote.
  it('survives null, undefined and junk', () => {
    expect(lineItemIdsFromAssociations(null)).toEqual([])
    expect(lineItemIdsFromAssociations(undefined)).toEqual([])
    expect(lineItemIdsFromAssociations('nope')).toEqual([])
    expect(lineItemIdsFromAssociations({ line_items: { results: 'nope' } })).toEqual([])
    expect(lineItemIdsFromAssociations({ line_items: {} })).toEqual([])
  })

  it('skips entries with no usable id rather than archiving an empty string', () => {
    const payload = { 'line items': { results: [{ id: '' }, { id: null }, {}, { id: '7' }] } }
    expect(lineItemIdsFromAssociations(payload)).toEqual(['7'])
  })

  it('accepts a numeric id, which HubSpot mixes in on some payloads', () => {
    expect(lineItemIdsFromAssociations({ line_items: { results: [{ id: 42 }] } })).toEqual(['42'])
  })
})
