import { describe, expect, it } from 'vitest'
import { HUBSPOT_PIPELINES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import { US_ACCEPTED_DEAL_STATUS } from '@/lib/customer-invoice/constants'
import {
  ACCEPTED_MID_EDIT_MESSAGE,
  isDealAccepted,
  recallBlockReason,
  republishBlockReason,
  snapshotToCartLines,
} from '@/lib/quote-edit'
import type { PricedCartLine } from '@/lib/quote-pricing'

/** A recallable quote on a deal that is merely quoted, not accepted. */
const OPEN = {
  rowStatus: 'published',
  hubspotQuoteId: '42607881765',
  dealStage: HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_SENT,
  registryDealStatus: 'Quote Created',
} as const

describe('recallBlockReason', () => {
  it('allows a published quote on an open deal', () => {
    expect(recallBlockReason(OPEN)).toBeNull()
  })

  it('refuses a quote that never finished publishing, pointing at Retry', () => {
    const reason = recallBlockReason({ ...OPEN, rowStatus: 'draft' })
    expect(reason).toMatch(/Retry quote/)
  })

  it('refuses a quote that failed, pointing at Retry', () => {
    expect(recallBlockReason({ ...OPEN, rowStatus: 'failed' })).toMatch(/Retry quote/)
  })

  it('refuses a quote already open for editing, and says so distinctly', () => {
    const reason = recallBlockReason({ ...OPEN, rowStatus: 'editing' })
    expect(reason).toMatch(/already recalled/)
    // Must NOT send the rep to Retry: retryHubSpotQuote resumes a generate and
    // would not republish an edit.
    expect(reason).not.toMatch(/Retry quote/)
  })

  it('refuses a row with no HubSpot quote id', () => {
    expect(recallBlockReason({ ...OPEN, hubspotQuoteId: null })).toMatch(/no HubSpot id/)
    expect(recallBlockReason({ ...OPEN, hubspotQuoteId: '   ' })).toMatch(/no HubSpot id/)
  })

  /**
   * The load-bearing guard. Republishing re-syncs deals_registry, and
   * notify_quote_accepted() fires the Xero AND MCS webhooks on any
   * line_items_raw change once deal_status is the accepted stage id, so an edit
   * here would raise a second Xero quote and a second MCS contract.
   */
  describe('the accepted-deal guard', () => {
    it.each(QUOTATION_ACCEPTED_STAGES)('refuses on live accepted stage %s', (stage) => {
      const reason = recallBlockReason({ ...OPEN, dealStage: stage })
      expect(reason).toMatch(/already been accepted/)
    })

    it('refuses when the registry says accepted even if HubSpot has not caught up', () => {
      // The registry value is what the database trigger actually reads, so it
      // alone is enough to stop.
      const reason = recallBlockReason({
        ...OPEN,
        dealStage: HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_SENT,
        registryDealStatus: US_ACCEPTED_DEAL_STATUS,
      })
      expect(reason).toMatch(/already been accepted/)
    })

    it('names Xero and MCS so the reason is actionable', () => {
      const reason = recallBlockReason({ ...OPEN, registryDealStatus: US_ACCEPTED_DEAL_STATUS })
      expect(reason).toMatch(/Xero/)
      expect(reason).toMatch(/MCS/)
    })
  })

  it('refuses a closed deal', () => {
    expect(
      recallBlockReason({ ...OPEN, dealStage: HUBSPOT_PIPELINES.USA_SALES.stages.CLOSED_WON }),
    ).toMatch(/closed/)
    expect(
      recallBlockReason({ ...OPEN, dealStage: HUBSPOT_PIPELINES.USA_SALES.stages.CLOSED_LOST }),
    ).toMatch(/closed/)
  })

  it('does not treat an unknown or empty stage as closed', () => {
    expect(recallBlockReason({ ...OPEN, dealStage: '' })).toBeNull()
    expect(recallBlockReason({ ...OPEN, dealStage: 'not-a-stage' })).toBeNull()
  })
})

/**
 * The same predicate is asked twice: once at recall, to refuse the edit, and
 * again just before the registry write, because the deal can be accepted WHILE
 * the rep has the builder open. Without the second check that stale answer
 * would let notify_quote_accepted() raise a second Xero quote and a second MCS
 * contract.
 */
describe('isDealAccepted', () => {
  it.each(QUOTATION_ACCEPTED_STAGES)('is true for accepted stage %s', (stage) => {
    expect(isDealAccepted(stage, 'Quote Created')).toBe(true)
  })

  it('is true when only the registry says accepted', () => {
    expect(
      isDealAccepted(HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_SENT, US_ACCEPTED_DEAL_STATUS),
    ).toBe(true)
  })

  it('is true when only HubSpot says accepted', () => {
    expect(
      isDealAccepted(HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_ACCEPTED, 'Quote Created'),
    ).toBe(true)
  })

  it('is false for an ordinary quoted deal', () => {
    expect(
      isDealAccepted(HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_SENT, 'Quote Created'),
    ).toBe(false)
  })

  it('is false when nothing is known, rather than throwing', () => {
    expect(isDealAccepted(null, null)).toBe(false)
    expect(isDealAccepted(undefined, undefined)).toBe(false)
    expect(isDealAccepted('', '')).toBe(false)
  })

  it('trims before comparing, so whitespace cannot slip past the guard', () => {
    expect(isDealAccepted('  ', `  ${US_ACCEPTED_DEAL_STATUS}  `)).toBe(true)
  })
})

describe('the mid-edit message', () => {
  it('explains that the quote is live but the deal was left alone', () => {
    expect(ACCEPTED_MID_EDIT_MESSAGE).toMatch(/republished/)
    expect(ACCEPTED_MID_EDIT_MESSAGE).toMatch(/Xero/)
    expect(ACCEPTED_MID_EDIT_MESSAGE).toMatch(/MCS/)
  })
})

describe('republishBlockReason', () => {
  it('allows a row that is open for editing', () => {
    expect(republishBlockReason('editing')).toBeNull()
  })

  it('refuses a published row and says to recall first', () => {
    expect(republishBlockReason('published')).toMatch(/Recall it first/)
  })

  it.each(['draft', 'failed', null, undefined, ''])('refuses %s', (status) => {
    expect(republishBlockReason(status)).not.toBeNull()
  })
})

/** Build a priced line the way priceCart would have stored it. */
function line(overrides: {
  hubspot: PricedCartLine['priced']['hubspot']
  quantity?: number
  lineTotal?: number
}): PricedCartLine {
  return {
    productId: 'p1',
    name: 'Echo Barrier H9',
    sku: 'EBH9NA',
    description: 'A panel',
    quantity: overrides.quantity ?? 2,
    priced: {
      listUnitPrice: 200,
      netUnitPrice: 180,
      registry: { unit_price: 200, discount_percentage: 10 },
      hubspot: overrides.hubspot,
    },
    priceSource: 'list',
    contractCompanyId: null,
    floorPrice: null,
    lineTotal: overrides.lineTotal ?? 360,
  } as PricedCartLine
}

/**
 * These exist because seeding an edit from the DEAL's line items loses the
 * discount (mapInitialLineItems drops those fields), which would silently
 * republish a discounted quote at full price.
 */
describe('snapshotToCartLines', () => {
  it('recovers a percentage discount', () => {
    const [cart] = snapshotToCartLines([line({ hubspot: { price: 200, hs_discount_percentage: 10 } })])
    expect(cart.discountMode).toBe('percent')
    expect(cart.discountValue).toBe(10)
    // The base, not the net: the builder's price column and the server both
    // work from the pre-discount figure.
    expect(cart.unitPrice).toBe(200)
  })

  it('recovers a per-unit cash discount', () => {
    const [cart] = snapshotToCartLines([line({ hubspot: { price: 200, discount: 20 } })])
    expect(cart.discountMode).toBe('amount')
    expect(cart.discountValue).toBe(20)
  })

  it('leaves an undiscounted line with no discount fields at all', () => {
    const [cart] = snapshotToCartLines([line({ hubspot: { price: 200 } })])
    expect(cart.discountMode).toBeUndefined()
    expect(cart.discountValue).toBeUndefined()
    expect('discountMode' in cart).toBe(false)
  })

  it('treats a zero discount as no discount', () => {
    const [pct] = snapshotToCartLines([line({ hubspot: { price: 200, hs_discount_percentage: 0 } })])
    expect(pct.discountMode).toBeUndefined()
    const [cash] = snapshotToCartLines([line({ hubspot: { price: 200, discount: 0 } })])
    expect(cash.discountMode).toBeUndefined()
  })

  it('prefers the percentage when both are somehow set', () => {
    // priceLine only ever sets one, so this is a defensive tie-break rather
    // than a real case. Percentage wins because that is what the registry
    // stores alongside a base price.
    const [cart] = snapshotToCartLines([
      line({ hubspot: { price: 200, hs_discount_percentage: 10, discount: 20 } }),
    ])
    expect(cart.discountMode).toBe('percent')
    expect(cart.discountValue).toBe(10)
  })

  it('carries identity, quantity and total through unchanged', () => {
    const [cart] = snapshotToCartLines([
      line({ hubspot: { price: 200 }, quantity: 3, lineTotal: 600 }),
    ])
    expect(cart).toMatchObject({
      productId: 'p1',
      name: 'Echo Barrier H9',
      sku: 'EBH9NA',
      description: 'A panel',
      quantity: 3,
      total: 600,
    })
  })

  it('maps an empty snapshot to an empty cart', () => {
    expect(snapshotToCartLines([])).toEqual([])
  })
})
