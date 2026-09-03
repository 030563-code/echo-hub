import { describe, it, expect } from 'vitest'
import {
  summariseTaxResponse,
  summariseDepotResponse,
  formatTaxRate,
} from '@/lib/customer-invoice/tax-breakdown'

/**
 * The fixture is the REAL stored response for USI2026-00010, read out of
 * customer_invoices.taxjar_response on korylyniwsqtsvzuzydg on 2026-09-03.
 * A Los Angeles delivery ex US-BAL: 9.75% combined, split 6.25 state / 1.00
 * county / 2.50 special district, with separately stated freight exempt.
 */
const LIVE_RESPONSE = [
  {
    depot: 'US-BAL',
    response: {
      tax: {
        rate: 0.0975,
        taxable_amount: 22295,
        amount_to_collect: 2173.76,
        freight_taxable: false,
        jurisdictions: { city: 'LOS ANGELES', state: 'CA', county: 'LOS ANGELES COUNTY', country: 'US' },
        breakdown: {
          shipping: null,
          line_items: [
            {
              id: 'L2',
              city_amount: 0,
              state_amount: 1286.25,
              city_tax_rate: 0,
              county_amount: 205.8,
              taxable_amount: 20580,
              county_tax_rate: 0.01,
              tax_collectable: 2006.55,
              special_tax_rate: 0.025,
              combined_tax_rate: 0.0975,
              state_sales_tax_rate: 0.0625,
              special_district_amount: 514.5,
            },
            {
              id: 'L3',
              city_amount: 0,
              state_amount: 107.19,
              city_tax_rate: 0,
              county_amount: 17.15,
              taxable_amount: 1715,
              county_tax_rate: 0.01,
              tax_collectable: 167.21,
              special_tax_rate: 0.025,
              combined_tax_rate: 0.0975,
              state_sales_tax_rate: 0.0625,
              special_district_amount: 42.87,
            },
          ],
        },
      },
    },
  },
]

describe('summariseTaxResponse against the live stored response', () => {
  const [bal] = summariseTaxResponse(LIVE_RESPONSE)

  it('reads the depot and the resolved jurisdiction, title-cased', () => {
    expect(bal.depot).toBe('US-BAL')
    // TaxJar shouts these back. A customer document should not.
    expect(bal.resolvedPlace).toBe('Los Angeles, Los Angeles County, CA')
  })

  it('splits the combined rate into the levels that actually apply', () => {
    expect(bal.combinedRate).toBe(0.0975)
    expect(bal.jurisdictions).toEqual([
      { label: 'State', rate: 0.0625, amount: 1393.44 },
      { label: 'County', rate: 0.01, amount: 222.95 },
      { label: 'Special district', rate: 0.025, amount: 557.37 },
    ])
  })

  it('drops a level that resolved to nothing rather than printing a zero row', () => {
    // City is present in the response at 0% / 0.00 and must not be shown.
    expect(bal.jurisdictions.some((j) => j.label === 'City')).toBe(false)
  })

  it('the jurisdiction rows add up to the sales tax charged', () => {
    const summed = bal.jurisdictions.reduce((acc, j) => acc + j.amount, 0)
    expect(Number(summed.toFixed(2))).toBe(bal.salesTax)
    expect(bal.salesTax).toBe(2173.76)
  })

  it('reports separately stated freight as exempt', () => {
    expect(bal.freightTaxable).toBe(false)
    expect(bal.shippingTax).toBe(0)
  })
})

/**
 * New Jersey includes delivery in the taxable sale where California exempts it.
 * The app must never decide that; it comes back from TaxJar per call, and the
 * shipping breakdown has to flow into the jurisdiction rows or the printed
 * split stops adding up to the tax charged.
 */
describe('a state that taxes freight', () => {
  const nj = summariseDepotResponse('US-BAL', {
    tax: {
      rate: 0.06625,
      taxable_amount: 23280,
      freight_taxable: true,
      jurisdictions: { city: 'NEWARK', state: 'NJ', county: 'ESSEX COUNTY', country: 'US' },
      breakdown: {
        shipping: { tax_collectable: 31.8, state_amount: 31.8, state_sales_tax_rate: 0.06625 },
        line_items: [
          { id: 'L1', tax_collectable: 1510.5, state_amount: 1510.5, state_sales_tax_rate: 0.06625, taxable_amount: 22800 },
        ],
      },
    },
  })

  it('folds the freight tax into the jurisdiction rows', () => {
    expect(nj.freightTaxable).toBe(true)
    expect(nj.shippingTax).toBe(31.8)
    expect(nj.jurisdictions).toEqual([{ label: 'State', rate: 0.06625, amount: 1542.3 }])
    expect(nj.salesTax).toBe(1542.3)
  })
})

describe('degrading rather than throwing', () => {
  it('returns nothing when tax has not been calculated', () => {
    expect(summariseTaxResponse(null)).toEqual([])
    expect(summariseTaxResponse(undefined)).toEqual([])
    expect(summariseTaxResponse({})).toEqual([])
    expect(summariseTaxResponse([])).toEqual([])
  })

  it('survives a response missing everything it expects', () => {
    const empty = summariseDepotResponse('US-SBD', {})
    expect(empty).toEqual({
      depot: 'US-SBD',
      resolvedPlace: '',
      combinedRate: null,
      taxableAmount: 0,
      shippingTax: 0,
      freightTaxable: false,
      jurisdictions: [],
      salesTax: 0,
    })
  })

  it('ignores a non-object entry in the array', () => {
    expect(summariseTaxResponse(['nonsense', 42, null])).toEqual([])
  })
})

describe('formatTaxRate', () => {
  it('prints three decimal places, as the mockup does', () => {
    expect(formatTaxRate(0.0975)).toBe('9.750%')
    expect(formatTaxRate(0.0625)).toBe('6.250%')
    expect(formatTaxRate(0.01)).toBe('1.000%')
    expect(formatTaxRate(0.06625)).toBe('6.625%')
  })
})
