/**
 * The filing side of the TaxJar mapping.
 *
 * The invariant these tests exist for: the destination TaxJar CALCULATES
 * against must equal the destination the completed order is FILED against, per
 * depot. Getting that wrong is silent (both calls return 200), only surfaces at
 * return time, and is exactly what a per-invoice rather than per-depot
 * destination used to cause on a collected order.
 */

import { describe, it, expect } from 'vitest'
import {
  buildTaxRequests,
  buildFilingOrders,
  type FilingLine,
} from '@/lib/customer-invoice/tax-mapping'
import { DEPOT_FROM_ADDRESSES } from '@/lib/customer-invoice/constants'

const shipTo = { street: '1218 Broadway', city: 'Santa Monica', state: 'CA', zip: '90404' }

const line = (overrides: Partial<FilingLine>): FilingLine => ({
  line_key: 'L1',
  quantity: 1,
  unit_price: 100,
  discount_percentage: 0,
  line_total: 100,
  is_shipping: false,
  ship_from_depot: 'US-BAL',
  sku: 'EBH9NA',
  name: 'Echo Barrier H9',
  description: null,
  tax_amount: 9.75,
  ...overrides,
})

const opts = { transactionDate: '2026-09-02', xeroInvoiceNumber: 'INV-0042' }

/** The to_ fields of a request or an order, for direct comparison. */
const destinationOf = (x: {
  to_country: string
  to_state: string
  to_zip: string
  to_city?: string
  to_street?: string
}) => ({
  to_country: x.to_country,
  to_state: x.to_state,
  to_zip: x.to_zip,
  to_city: x.to_city,
  to_street: x.to_street,
})

describe('buildFilingOrders destination parity with buildTaxRequests', () => {
  const lines = [
    line({ line_key: 'L1' }),
    line({ line_key: 'L2', is_shipping: true, line_total: 250, unit_price: 250, sku: 'LTLNA', tax_amount: 0 }),
  ]

  it('files to the same destination the calculation used, delivered', () => {
    const calc = buildTaxRequests(lines, shipTo, 'US123', false)
    const filing = buildFilingOrders(lines, shipTo, 'US123', false, opts)
    expect(calc.ok && filing.ok).toBe(true)
    if (!calc.ok || !filing.ok) return
    expect(filing.orders).toHaveLength(calc.groups.length)
    expect(destinationOf(filing.orders[0])).toEqual(destinationOf(calc.groups[0].request))
    expect(filing.orders[0].to_state).toBe('CA')
  })

  it('files to the same destination the calculation used, collected', () => {
    const calc = buildTaxRequests(lines, null, 'US123', true)
    const filing = buildFilingOrders(lines, null, 'US123', true, opts)
    expect(calc.ok && filing.ok).toBe(true)
    if (!calc.ok || !filing.ok) return
    expect(destinationOf(filing.orders[0])).toEqual(destinationOf(calc.groups[0].request))
    expect(filing.orders[0].to_state).toBe('MD')
  })

  it('holds parity PER DEPOT on a collected two-depot invoice', () => {
    // The case that catches a destination computed once outside the loop: the
    // first depot would look right and the second would be filed in the wrong
    // state.
    const original = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = {
      street: '9400 Santa Anita Ave',
      city: 'Rancho Cucamonga',
      state: 'CA',
      zip: '91730',
      country: 'US',
    }
    try {
      const twoDepot = [line({ line_key: 'L1' }), line({ line_key: 'L2', ship_from_depot: 'US-SBD' })]
      const calc = buildTaxRequests(twoDepot, null, null, true)
      const filing = buildFilingOrders(twoDepot, null, null, true, opts)
      expect(calc.ok && filing.ok).toBe(true)
      if (!calc.ok || !filing.ok) return
      expect(filing.orders).toHaveLength(2)
      for (let i = 0; i < filing.orders.length; i++) {
        expect(destinationOf(filing.orders[i])).toEqual(destinationOf(calc.groups[i].request))
      }
      expect(filing.orders[0].to_state).toBe('MD')
      expect(filing.orders[1].to_state).toBe('CA')
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = original
    }
  })

  it('keeps the freight-fold host consistent between calculation and filing', () => {
    const withOrphanFreight = [
      line({ line_key: 'L1' }),
      line({
        line_key: 'L2',
        ship_from_depot: 'US-SBD',
        is_shipping: true,
        line_total: 90,
        unit_price: 90,
        sku: 'LTLNA',
        tax_amount: 0,
      }),
    ]
    const calc = buildTaxRequests(withOrphanFreight, shipTo, null, false)
    const filing = buildFilingOrders(withOrphanFreight, shipTo, null, false, opts)
    expect(calc.ok && filing.ok).toBe(true)
    if (!calc.ok || !filing.ok) return
    // Freight follows the goods into the same host depot on both sides, or the
    // freight tax is filed in a jurisdiction the calculation never used.
    expect(calc.groups).toHaveLength(1)
    expect(filing.orders).toHaveLength(1)
    expect(calc.groups[0].depot).toBe('US-BAL')
    expect(calc.groups[0].request.shipping).toBe(90)
    expect(filing.orders[0].shipping).toBe(90)
  })
})

describe('buildFilingOrders amounts', () => {
  it('excludes tax from the filed amount', () => {
    // TaxJar enforces amount == sum(line_items) + shipping EXCLUDING tax, and
    // rejects with a 422 after Xero has already authorised the invoice.
    const lines = [
      line({ line_key: 'L1', quantity: 2, unit_price: 100, line_total: 200, tax_amount: 19.5 }),
      line({ line_key: 'L2', is_shipping: true, unit_price: 250, line_total: 250, sku: 'LTLNA', tax_amount: 5 }),
    ]
    const filing = buildFilingOrders(lines, shipTo, null, false, opts)
    expect(filing.ok).toBe(true)
    if (!filing.ok) return
    const [order] = filing.orders
    expect(order.amount).toBe(450)
    expect(order.shipping).toBe(250)
    expect(order.sales_tax).toBe(24.5)
  })

  it('derives the discount so TaxJar arithmetic lands on our stored total', () => {
    const filing = buildFilingOrders(
      [line({ quantity: 10, unit_price: 100, discount_percentage: 15, line_total: 850 })],
      shipTo,
      null,
      false,
      opts,
    )
    expect(filing.ok).toBe(true)
    if (!filing.ok) return
    const item = filing.orders[0].line_items[0]
    expect(item.discount).toBe(150)
    expect(item.quantity * item.unit_price - (item.discount ?? 0)).toBe(filing.orders[0].amount)
  })

  it('suffixes the transaction id only when the invoice spans two depots', () => {
    const single = buildFilingOrders([line({ line_key: 'L1' })], shipTo, null, false, opts)
    expect(single.ok).toBe(true)
    if (single.ok) expect(single.orders[0].transaction_id).toBe('INV-0042')

    const original = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = {
      street: '9400 Santa Anita Ave',
      city: 'Rancho Cucamonga',
      state: 'CA',
      zip: '91730',
      country: 'US',
    }
    try {
      const both = buildFilingOrders(
        [line({ line_key: 'L1' }), line({ line_key: 'L2', ship_from_depot: 'US-SBD' })],
        shipTo,
        null,
        false,
        opts,
      )
      expect(both.ok).toBe(true)
      if (!both.ok) return
      expect(both.orders.map((o) => o.transaction_id)).toEqual(['INV-0042-US-BAL', 'INV-0042-US-SBD'])
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = original
    }
  })

  it('refuses to file a delivered invoice with no delivery address', () => {
    const filing = buildFilingOrders([line({ line_key: 'L1' })], null, null, false, opts)
    expect(filing.ok).toBe(false)
  })
})
