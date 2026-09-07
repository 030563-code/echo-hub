import { describe, it, expect } from 'vitest'
import {
  applyComposition,
  linesTotal,
  type CompositionLine,
  type CompositionRule,
} from '@/lib/invoice-composition'

const line = (sku: string, qty: number, unit: number, hs: string | null = null): CompositionLine => ({
  sku,
  product_name: sku,
  qty,
  unit_value: unit,
  hs_code: hs,
})

const rule = (r: Partial<CompositionRule>): CompositionRule => ({
  id: 'r',
  active: true,
  country: null,
  leg: null,
  rule_type: 'consolidate',
  source_sku: 'X',
  config: {},
  priority: 100,
  ...r,
})

describe('applyComposition', () => {
  it('is the identity when no rules/HS match', () => {
    const lines = [line('EBH9NA', 10, 100), line('PACKING', 1, 50)]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules: [], hsCodes: [] })
    expect(out).toEqual(lines)
  })

  it('CONSOLIDATE (Brazil): folds packing+shipping into H9, value-preserving', () => {
    const lines = [line('EBH9NA', 10, 100), line('PACKING', 1, 50), line('SHIPPING', 1, 30)]
    const rules = [
      rule({ rule_type: 'consolidate', country: 'BR', source_sku: 'EBH9NA', config: { absorb_skus: ['PACKING', 'SHIPPING'] } }),
    ]
    const before = linesTotal(lines) // 1000 + 50 + 30 = 1080
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: 'BR', rules, hsCodes: [] })
    expect(out).toHaveLength(1)
    expect(out[0].sku).toBe('EBH9NA')
    expect(out[0].qty).toBe(10)
    expect(out[0].unit_value).toBeCloseTo(108, 6) // 1080 / 10
    expect(linesTotal(out)).toBeCloseTo(before, 2) // value preserved
  })

  it('CONSOLIDATE does not fire when the destination country differs', () => {
    const lines = [line('EBH9NA', 10, 100), line('PACKING', 1, 50)]
    const rules = [rule({ rule_type: 'consolidate', country: 'BR', source_sku: 'EBH9NA', config: { absorb_skus: ['PACKING'] } })]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: 'DE', rules, hsCodes: [] })
    expect(out).toHaveLength(2) // unchanged
  })

  it('SPLIT (CS Enclosure): one SKU → 2 HS-coded lines, value-preserving', () => {
    const lines = [line('CCSNA', 4, 200)] // total 800
    const rules = [
      rule({
        rule_type: 'split',
        leg: 'SRO_TO_GROUP',
        source_sku: 'CCSNA',
        config: {
          children: [
            { label: 'Frame', hs_code: '7308.90', share: 0.6 },
            { label: 'Body', hs_code: '6306.12', share: 0.4 },
          ],
        },
      }),
    ]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules, hsCodes: [] })
    expect(out).toHaveLength(2)
    expect(out.map((l) => l.hs_code)).toEqual(['7308.90', '6306.12'])
    expect(out[0].unit_value).toBeCloseTo(120, 6) // 800*0.6/4
    expect(out[1].unit_value).toBeCloseTo(80, 6) //  800*0.4/4
    expect(out.every((l) => l.qty === 4)).toBe(true)
    expect(linesTotal(out)).toBeCloseTo(800, 2) // value preserved
  })

  it('SPLIT normalises shares that do not sum to 1', () => {
    const lines = [line('CCSNA', 1, 100)]
    const rules = [
      rule({
        rule_type: 'split',
        source_sku: 'CCSNA',
        config: { children: [{ label: 'A', hs_code: null, share: 3 }, { label: 'B', hs_code: null, share: 1 }] },
      }),
    ]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules, hsCodes: [] })
    expect(out[0].unit_value).toBeCloseTo(75, 6) // 3/4
    expect(out[1].unit_value).toBeCloseTo(25, 6) // 1/4
    expect(linesTotal(out)).toBeCloseTo(100, 2)
  })

  it('per-leg HS: same SKU gets different codes on different legs', () => {
    const lines = [line('EBH9NA', 1, 100)]
    const hsCodes = [
      { sku: 'EBH9NA', leg: 'SRO_TO_GROUP', hs_code: 'AAA' },
      { sku: 'EBH9NA', leg: 'GROUP_TO_USA', hs_code: 'BBB' },
    ]
    const a = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules: [], hsCodes })
    const b = applyComposition(lines, { leg: 'GROUP_TO_USA', country: null, rules: [], hsCodes })
    expect(a.lines[0].hs_code).toBe('AAA')
    expect(b.lines[0].hs_code).toBe('BBB')
  })

  it('HS map falls back to the leg-agnostic (*) entry', () => {
    const lines = [line('EBH9NA', 1, 100)]
    const hsCodes = [{ sku: 'EBH9NA', leg: '*', hs_code: 'DEFAULT' }]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules: [], hsCodes })
    expect(out[0].hs_code).toBe('DEFAULT')
  })

  it('split children take their own HS codes, not the generic map', () => {
    const lines = [line('CCSNA', 2, 100)]
    const hsCodes = [{ sku: 'CCSNA', leg: '*', hs_code: 'GENERIC' }]
    const rules = [
      rule({
        rule_type: 'split',
        source_sku: 'CCSNA',
        config: { children: [{ label: 'Frame', hs_code: 'FRAME_HS', share: 0.5 }, { label: 'Body', hs_code: null, share: 0.5 }] },
      }),
    ]
    const { lines: out } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: null, rules, hsCodes })
    expect(out[0].hs_code).toBe('FRAME_HS')
    expect(out[1].hs_code).toBeNull() // pending config — NOT the generic map code
  })

  it('combined consolidate + split preserves the grand total', () => {
    const lines = [line('EBH9NA', 10, 100), line('PACKING', 1, 40), line('CCSNA', 2, 200)]
    const rules = [
      rule({ rule_type: 'consolidate', country: 'BR', source_sku: 'EBH9NA', config: { absorb_skus: ['PACKING'] } }),
      rule({
        rule_type: 'split',
        source_sku: 'CCSNA',
        config: { children: [{ label: 'F', hs_code: 'x', share: 0.5 }, { label: 'B', hs_code: 'y', share: 0.5 }] },
      }),
    ]
    const before = linesTotal(lines) // 1000 + 40 + 400 = 1440
    const { lines: out, applied } = applyComposition(lines, { leg: 'SRO_TO_GROUP', country: 'BR', rules, hsCodes: [] })
    expect(linesTotal(out)).toBeCloseTo(before, 2)
    expect(applied.length).toBe(2)
  })
})
