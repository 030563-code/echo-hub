import { describe, it, expect } from 'vitest'
import { computeZones, computeNFP, zoneFor, qualifySpikes, varFactorFromCov } from '@/lib/mrp/buffers'

const profile = { adu: 10, dltDays: 75, ltFactor: 0.25, varFactor: 0.6, moq: 0, containerQty: 0 }

describe('computeZones', () => {
  it('DDMRP zone math: yellow=ADU·DLT, green=max(ADU·DLT·LTf, MOQ, container), red=base·(1+VF)', () => {
    const z = computeZones(profile)
    expect(z.yellow).toBe(750)                    // 10*75
    expect(z.green).toBe(188)                     // ceil(10*75*0.25)
    expect(z.red).toBe(300)                       // ceil(187.5*(1+0.6))
    expect(z.yellowTop).toBe(z.red + z.yellow)    // 1050
    expect(z.greenTop).toBe(z.red + z.yellow + z.green) // 1238
  })
  it('green respects MOQ and container quantity', () => {
    expect(computeZones({ ...profile, moq: 400 }).green).toBe(400)
    expect(computeZones({ ...profile, containerQty: 500 }).green).toBe(500)
  })
  it('zero ADU collapses zones to MOQ-only green, zero red — never NaN', () => {
    const z = computeZones({ ...profile, adu: 0, moq: 100 })
    expect(z).toEqual({ red: 0, yellow: 0, green: 100, yellowTop: 0, greenTop: 100 })
  })
  it('clamps pathological inputs: negative ADU → 0, non-finite varFactor → 1.0 — never NaN/negative', () => {
    const z = computeZones({ ...profile, adu: -5, varFactor: NaN, moq: 100 })
    expect(z).toEqual({ red: 0, yellow: 0, green: 100, yellowTop: 0, greenTop: 100 })
    const z2 = computeZones({ ...profile, varFactor: null as unknown as number })
    expect(z2.red).toBe(375)                      // ceil(187.5*(1+varFactorFromCov(null)=1.0))
    for (const v of Object.values(z2)) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('varFactorFromCov', () => {
  it('maps measured CoV to DDMRP variability factor', () => {
    expect(varFactorFromCov(0.5)).toBe(0.4)
    expect(varFactorFromCov(1.5)).toBe(0.6)
    expect(varFactorFromCov(3.2)).toBe(1.0)
    expect(varFactorFromCov(null)).toBe(1.0)      // unknown → most conservative
  })
})

describe('computeNFP', () => {
  it('NFP = on_hand + on_order_deduped + in_transit − firm; projected subtracts weighted spikes', () => {
    const r = computeNFP({ onHand: 100, inTransit: 200, onOrder: 300, firmDemand: 150,
      spikes: [{ qty: 200, weight: 0.5, qualified: true }, { qty: 999, weight: 0.9, qualified: false }] })
    expect(r.nfp).toBe(450)
    expect(r.projectedNfp).toBe(350)              // only qualified spikes count
  })
})

describe('zoneFor', () => {
  const zones = { red: 100, yellow: 400, green: 150, yellowTop: 500, greenTop: 650 }
  it('classifies by NFP vs zone tops and sizes the order to green-top', () => {
    expect(zoneFor(650, zones)).toEqual({ zone: 'green', actionQty: 0 })
    expect(zoneFor(450, zones)).toEqual({ zone: 'yellow', actionQty: 200 })
    expect(zoneFor(90, zones)).toEqual({ zone: 'red', actionQty: 560 })
  })
})

describe('qualifySpikes', () => {
  it('spike = qty ≥ threshold, due inside horizon, late-stage only', () => {
    const today = new Date('2026-08-07')
    const out = qualifySpikes([
      { dealId: 'a', qty: 60, dueDate: '2026-09-20', lateStage: true,  weight: 0.4 },
      { dealId: 'b', qty: 10, dueDate: '2026-09-20', lateStage: true,  weight: 0.4 }, // below threshold
      { dealId: 'c', qty: 80, dueDate: '2027-03-01', lateStage: true,  weight: 0.4 }, // outside horizon
      { dealId: 'd', qty: 80, dueDate: '2026-09-01', lateStage: false, weight: 0.4 }, // early stage
    ], { redZone: 100, horizonDays: 105, today })
    expect(out.map(s => s.dealId)).toEqual(['a'])
  })
})
