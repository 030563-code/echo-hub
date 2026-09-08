import { describe, it, expect } from 'vitest'
import { pickContractPrice } from '@/lib/pricing'

const base = { hubspot_company_id: '1', sku: 'EBH9NA', currency: 'USD' }
const where = { sku: 'EBH9NA', currency: 'USD', companyId: '1', today: '2026-09-08' }

describe('the contract price a grid cell shows', () => {
  it('is the most recently negotiated one in force', () => {
    const rows = [
      { ...base, unit_price: 100, valid_from: '2026-01-01', valid_to: null },
      { ...base, unit_price: 90, valid_from: '2026-06-01', valid_to: null },
    ]
    expect(pickContractPrice(rows, where)?.unit_price).toBe(90)
  })

  it('ignores a price that has not started or has ended', () => {
    expect(
      pickContractPrice([{ ...base, unit_price: 80, valid_from: '2026-12-01', valid_to: null }], where),
    ).toBeNull()
    expect(
      pickContractPrice([{ ...base, unit_price: 80, valid_from: null, valid_to: '2026-01-01' }], where),
    ).toBeNull()
  })

  it('ignores a switched-off price', () => {
    expect(
      pickContractPrice([{ ...base, unit_price: 80, valid_from: null, valid_to: null, is_active: false }], where),
    ).toBeNull()
  })

  it('never crosses company, sku or currency', () => {
    const rows = [
      { ...base, hubspot_company_id: '2', unit_price: 10, valid_from: null, valid_to: null },
      { ...base, sku: 'EBH10NA', unit_price: 20, valid_from: null, valid_to: null },
      { ...base, currency: 'CAD', unit_price: 30, valid_from: null, valid_to: null },
    ]
    expect(pickContractPrice(rows, where)).toBeNull()
  })

  it('takes a price with no dates at all', () => {
    expect(
      pickContractPrice([{ ...base, unit_price: 181, valid_from: null, valid_to: null }], where)?.unit_price,
    ).toBe(181)
  })
})
