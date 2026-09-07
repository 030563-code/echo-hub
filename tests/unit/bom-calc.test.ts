import { describe, it, expect } from 'vitest'
import { priceComponents, recomputeTotals } from '@/lib/bom-calc'
import type { BomComponent } from '@/lib/erp-types'

const comp = (over: Partial<BomComponent>): BomComponent => ({
  code: 'X', desc: null, qty: 1, currency: 'EUR', dutiable: false, unit_cost_eur: 0, extended_eur: 0, ...over,
})

describe('priceComponents', () => {
  it('overrides the unit price from the master and recomputes extended', () => {
    const detail = [comp({ code: 'A', qty: 2, unit_cost_eur: 10 }), comp({ code: 'B', qty: 1, unit_cost_eur: 5 })]
    const priced = priceComponents(detail, new Map([['A', 12]]))
    expect(priced[0]).toMatchObject({ code: 'A', unit_cost_eur: 12, extended_eur: 24 }) // overridden
    expect(priced[1]).toMatchObject({ code: 'B', unit_cost_eur: 5, extended_eur: 5 }) // fallback to snapshot
  })
})

describe('recomputeTotals', () => {
  it('applies the duty only to dutiable components and rolls up correctly', () => {
    const priced = [comp({ dutiable: true, extended_eur: 24 }), comp({ dutiable: false, extended_eur: 5 })]
    const t = recomputeTotals(priced, 48.55, 12.5, 3.3)
    expect(t.sro_components_eur).toBe(29) // 24 + 5
    expect(t.sro_duty_8pct_eur).toBe(1.92) // 8% of 24 (dutiable only)
    expect(t.sro_total_eur).toBe(34.22) // 29 + 1.92 + 3.30
    expect(t.bamida_total_eur).toBe(61.05) // 48.55 + 12.50
    expect(t.bom_total_eur).toBe(95.27) // 61.05 + 34.22
  })

  it('reproduces the real H9 snapshot totals from its component aggregate', () => {
    // H9 (verified): components €22.88 (of which €10.313 dutiable), admin €3.30,
    // man €48.55, print €12.50 → sro_total €27.005, bom_total €88.055.
    const priced = [comp({ dutiable: true, extended_eur: 10.313 }), comp({ dutiable: false, extended_eur: 12.567 })]
    const t = recomputeTotals(priced, 48.55, 12.5, 3.3)
    expect(t.sro_components_eur).toBe(22.88)
    expect(t.sro_duty_8pct_eur).toBe(0.825) // round4(0.08 * 10.313)
    expect(t.sro_total_eur).toBe(27.005)
    expect(t.bom_total_eur).toBe(88.055)
  })

  // Regression lock (review H1): the FULL pipeline (priceComponents → recomputeTotals)
  // over H9's REAL 6 components at snapshot prices must reproduce the stored €88.055
  // exactly — i.e. our round-per-line-then-sum matches the synced-Sheet staging.
  it('reproduces the real H9 snapshot bom_total from its actual components (empty master = snapshot prices)', () => {
    const h9 = [
      { code: 'ACI-T40', qty: 1, unit_cost_eur: 7.16, dutiable: false },
      { code: 'ACI-TRNS', qty: 1, unit_cost_eur: 0.59, dutiable: false },
      { code: 'DAT-01', qty: 1, unit_cost_eur: 1.1555, dutiable: false },
      { code: 'PC350FR-UV21', qty: 1.5, unit_cost_eur: 6.8753, dutiable: true },
      { code: 'PC350FR-TRNS', qty: 1.5, unit_cost_eur: 0.13, dutiable: false },
      { code: 'GRP-SLTF', qty: 1.5, unit_cost_eur: 2.311, dutiable: false },
    ].map((x) => comp(x))
    const priced = priceComponents(h9, new Map()) // empty master → snapshot unit costs
    const t = recomputeTotals(priced, 48.55, 12.5, 3.3)
    expect(t.sro_components_eur).toBe(22.88)
    expect(t.sro_duty_8pct_eur).toBe(0.825)
    expect(t.sro_total_eur).toBe(27.005)
    expect(t.bom_total_eur).toBe(88.055) // === the stored snapshot bom_total
  })
})
