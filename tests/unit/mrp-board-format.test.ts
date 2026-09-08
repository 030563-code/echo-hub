import { describe, it, expect } from 'vitest'
import {
  zoneChipClasses,
  humanizeFlag,
  normalizeFlags,
  formatQty,
  projectedDiffers,
  formatPStockout,
  formatDataGrade,
  pStockoutCiHint,
  commonDltDays,
  formatLastRun,
  formatMaxBuildable,
} from '@/lib/mrp/board-format'

describe('zoneChipClasses', () => {
  it('maps each zone to its traffic-light palette', () => {
    expect(zoneChipClasses('red')).toContain('text-red-700')
    expect(zoneChipClasses('yellow')).toContain('text-amber-700')
    expect(zoneChipClasses('green')).toContain('text-emerald-700')
  })
  it('unknown zones degrade to the neutral chip (zone column is nullable)', () => {
    for (const z of ['', 'purple', 'RED']) {
      expect(zoneChipClasses(z)).toContain('text-gray-600')
    }
  })
})

describe('humanizeFlag', () => {
  it('labels every engine flag', () => {
    expect(humanizeFlag('stock_unverified')).toBe('Stock unverified')
    expect(humanizeFlag('buffers_unseeded')).toBe('Buffers unseeded')
    expect(humanizeFlag('spikes_skipped_no_buffer')).toBe('Spikes skipped (no buffer)')
    expect(humanizeFlag('thin_history')).toBe('Thin history')
    expect(humanizeFlag('demand_capture_gap')).toBe('Demand capture gap')
    expect(humanizeFlag('stock_drift')).toBe('Stock drift')
    expect(humanizeFlag('materials_unmapped')).toBe('No BOM mapped')
    expect(humanizeFlag('materials_map_provisional')).toBe('BOM mapping provisional')
    expect(humanizeFlag('pallet_size_unknown')).toBe('Pallet size unknown')
  })
  it('unknown flags degrade to sentence case, never raw snake_case', () => {
    expect(humanizeFlag('future_new_flag')).toBe('Future new flag')
    expect(humanizeFlag('x')).toBe('X')
  })
})

describe('normalizeFlags', () => {
  it('keeps string entries, drops everything else', () => {
    expect(normalizeFlags(['a', 1, null, 'b', {}])).toEqual(['a', 'b'])
  })
  it('non-array jsonb (object, null, bare string) → []', () => {
    expect(normalizeFlags({ a: 1 })).toEqual([])
    expect(normalizeFlags(null)).toEqual([])
    expect(normalizeFlags('stock_drift')).toEqual([])
  })
})

describe('formatQty', () => {
  it('integers render bare; fractional NFP to one decimal', () => {
    expect(formatQty(320)).toBe('320')
    expect(formatQty(0)).toBe('0')
    expect(formatQty(-12)).toBe('-12')
    expect(formatQty(12.34)).toBe('12.3')
    expect(formatQty(12.96)).toBe('13.0')
  })
  it('null/undefined/non-finite → em dash', () => {
    expect(formatQty(null)).toBe('—')
    expect(formatQty(undefined)).toBe('—')
    expect(formatQty(NaN)).toBe('—')
    expect(formatQty(Infinity)).toBe('—')
  })
})

describe('projectedDiffers', () => {
  it('true only when projected differs at display precision', () => {
    expect(projectedDiffers(100, 80)).toBe(true)
    expect(projectedDiffers(100, 100)).toBe(false)
    expect(projectedDiffers(12.34, 12.30001)).toBe(false) // both display 12.3
    expect(projectedDiffers(12.3, 12.7)).toBe(true)
  })
  it('null projected never shows a second value', () => {
    expect(projectedDiffers(100, null)).toBe(false)
    expect(projectedDiffers(null, null)).toBe(false)
    expect(projectedDiffers(100, undefined)).toBe(false)
  })
})

describe('formatPStockout', () => {
  it('null (the engine does not write p_stockout yet) → em dash', () => {
    expect(formatPStockout(null)).toBe('—')
    expect(formatPStockout(undefined)).toBe('—')
  })
  it('probability in [0,1] renders as a whole percent', () => {
    expect(formatPStockout(0)).toBe('0%')
    expect(formatPStockout(0.07)).toBe('7%')
    expect(formatPStockout(0.5)).toBe('50%')
    expect(formatPStockout(1)).toBe('100%')
  })
})

describe('formatDataGrade', () => {
  it('known grades pass through unchanged', () => {
    expect(formatDataGrade('A')).toBe('A')
    expect(formatDataGrade('B')).toBe('B')
    expect(formatDataGrade('C')).toBe('C')
  })
  it('null (no MC result yet) → em dash', () => {
    expect(formatDataGrade(null)).toBe('—')
  })
})

describe('pStockoutCiHint', () => {
  it('CI wider than 0.30 shows the collect-data hint', () => {
    expect(pStockoutCiHint(0.31)).toBe('±wide — collect data')
    expect(pStockoutCiHint(0.5)).toBe('±wide — collect data')
  })
  it('CI at or below 0.30 shows nothing', () => {
    expect(pStockoutCiHint(0.3)).toBeNull()
    expect(pStockoutCiHint(0.1)).toBeNull()
    expect(pStockoutCiHint(0)).toBeNull()
  })
  it('null/undefined/non-finite → nothing', () => {
    expect(pStockoutCiHint(null)).toBeNull()
    expect(pStockoutCiHint(undefined)).toBeNull()
    expect(pStockoutCiHint(NaN)).toBeNull()
  })
})

describe('commonDltDays', () => {
  it('mode of profile dlt_days (all 75d seeds today → 75)', () => {
    expect(commonDltDays([75, 75, 75])).toBe(75)
    expect(commonDltDays([75, 75, 90])).toBe(75)
  })
  it('ties break to the smaller value — deterministic regardless of order', () => {
    expect(commonDltDays([90, 75])).toBe(75)
    expect(commonDltDays([75, 90])).toBe(75)
  })
  it('empty or no finite values → null', () => {
    expect(commonDltDays([])).toBe(null)
    expect(commonDltDays([NaN])).toBe(null)
  })
})

describe('formatLastRun', () => {
  it('run date + persistence time in UTC (deterministic server render)', () => {
    expect(formatLastRun('2026-08-08', '2026-08-08T04:12:34.123+00:00')).toBe(
      'Last run 2026-08-08 · persisted 04:12 UTC'
    )
    // non-UTC offset normalises to UTC
    expect(formatLastRun('2026-08-08', '2026-08-08T06:12:00+02:00')).toBe(
      'Last run 2026-08-08 · persisted 04:12 UTC'
    )
  })
  it('missing/invalid created_at degrades to the run date alone', () => {
    expect(formatLastRun('2026-08-08', null)).toBe('Last run 2026-08-08')
    expect(formatLastRun('2026-08-08', 'not-a-date')).toBe('Last run 2026-08-08')
  })
})

describe('formatMaxBuildable', () => {
  it('names the binding component, because the bare ceiling is not actionable', () => {
    expect(formatMaxBuildable(280, '1781', 'Kovove istenie')).toBe('280 · capped by Kovove istenie')
  })
  it('falls back to the ns_number when no description was snapshotted', () => {
    expect(formatMaxBuildable(48, '900', null)).toBe('48 · capped by 900')
    expect(formatMaxBuildable(48, '900', '   ')).toBe('48 · capped by 900')
  })
  it('renders a bare number when nothing bound', () => {
    expect(formatMaxBuildable(120, null, null)).toBe('120')
  })
  it('em-dashes an unknown ceiling rather than implying zero capacity', () => {
    expect(formatMaxBuildable(null, null, null)).toBe('—')
    expect(formatMaxBuildable(undefined, '1781', 'Clip')).toBe('—')
    expect(formatMaxBuildable(Number.NaN, null, null)).toBe('—')
  })
  it('keeps a real zero distinct from unknown', () => {
    expect(formatMaxBuildable(0, '5097', 'Mehler')).toBe('0 · capped by Mehler')
  })
})

describe('humanizeFlag — materials vocabulary', () => {
  it('labels the provisional-mapping flag explicitly', () => {
    expect(humanizeFlag('materials_map_provisional')).toBe('BOM mapping provisional')
    expect(humanizeFlag('materials_unmapped')).toBe('No BOM mapped')
  })
  it('degrades an unknown future flag to sentence case rather than snake_case', () => {
    expect(humanizeFlag('some_future_flag')).toBe('Some future flag')
  })
})
