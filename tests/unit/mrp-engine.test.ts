import { describe, it, expect } from 'vitest'
import {
  parseLineItems, isoWeekKey, trailingIsoWeeks, weeklyTotals, covFromWeeklyTotals,
  median, dltDaysFor, onOrderBySku, maxBuildableFor, runMrpEngine,
  type EngineData, type ProfileRow, type StatusDailyRow, type SpikeRegisterRow,
  type ProfileWriteBack,
} from '@/lib/mrp/engine'

// ---------------------------------------------------------------------------
// Stub data-access (tests/stubs pattern: in-memory fixtures, no IO ever).
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-08T00:00:00Z') // runDate 2026-08-08; ADU window > 2026-02-09; firm > 2026-07-25

function profile(over: Partial<ProfileRow> & { sku: string }): ProfileRow {
  return {
    sku_class: 'slow', family_sku: null, adu: null, adu_source: 'auto', cov: null,
    dlt_days: 75, mfg_lt: 45, ocean_lt: 21, customs_lt: 9, lt_factor: 0.25,
    var_factor: null, moq: 0, container_qty: null, seeded: true, alias_of: null,
    ...over,
  }
}

interface Fixtures {
  profiles: ProfileRow[]
  demandEvents: { event_date: string; sku: string; qty: number; source: string }[]
  stockLevels: { warehouse_code: string; sku: string; quantity_on_hand: number; last_counted_at: string | null }[]
  shipments: { sku: string; qty: number; status: string; po_id: string | null }[]
  openPoLines: { po_id: string; sku: string; quantity: number }[]
  stageWeights: { stage_id: string; win_weight: number; is_late_stage: boolean }[]
  openDeals: { hubspot_deal_id: string; deal_status: string; line_items_raw: unknown }[]
  closedWonDeals: { hubspot_deal_id: string; deal_status: string; line_items_raw: unknown }[]
  hubspotDemandDealIds: string[]
  bomMap: { finished_sku: string; component_code: string; qty_per: number; bamida_item_name: string | null; verified: boolean; last_seen_week: string | null }[]
  materialStock: { item_name: string; available_quantity: number }[]
  doorLeadTimeDays: number[]
  receiptRows: { depot: string; sku: string; qty: number }[]
}

interface Captured {
  status: StatusDailyRow[][]
  spikes: SpikeRegisterRow[][]
  writeBacks: ProfileWriteBack[][]
}

function makeData(over: Partial<Fixtures> = {}): { data: EngineData; captured: Captured } {
  const f: Fixtures = {
    profiles: [], demandEvents: [], stockLevels: [], shipments: [], openPoLines: [],
    stageWeights: [], openDeals: [], closedWonDeals: [], hubspotDemandDealIds: [],
    bomMap: [], materialStock: [], doorLeadTimeDays: [], receiptRows: [],
    ...over,
  }
  const captured: Captured = { status: [], spikes: [], writeBacks: [] }
  const data: EngineData = {
    profiles: () => Promise.resolve(f.profiles),
    demandEvents: (since) => Promise.resolve(f.demandEvents.filter(e => e.event_date > since)),
    stockLevels: () => Promise.resolve(f.stockLevels),
    shipments: () => Promise.resolve(f.shipments),
    openPoLines: () => Promise.resolve(f.openPoLines),
    stageWeights: () => Promise.resolve(f.stageWeights),
    openDeals: () => Promise.resolve(f.openDeals),
    closedWonDeals: () => Promise.resolve(f.closedWonDeals),
    hubspotDemandDealIds: () => Promise.resolve(new Set(f.hubspotDemandDealIds)),
    bomMap: () => Promise.resolve(f.bomMap),
    materialStock: () => Promise.resolve(f.materialStock),
    doorLeadTimeDays: () => Promise.resolve(f.doorLeadTimeDays),
    receiptRows: () => Promise.resolve(f.receiptRows),
    persistStatus: (rows) => { captured.status.push(rows); return Promise.resolve() },
    persistSpikes: (rows) => { captured.spikes.push(rows); return Promise.resolve() },
    writeBackProfiles: (rows) => { captured.writeBacks.push(rows); return Promise.resolve() },
  }
  return { data, captured }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseLineItems', () => {
  it('accepts numeric and numeric-string quantities, trims skus', () => {
    expect(parseLineItems([
      { sku: ' EBH9NA ', quantity: 5 },
      { sku: 'HKNA', quantity: '12' },
    ])).toEqual([{ sku: 'EBH9NA', qty: 5 }, { sku: 'HKNA', qty: 12 }])
  })
  it('drops blanks, non-positives, junk and non-arrays', () => {
    expect(parseLineItems([
      { sku: '', quantity: 5 }, { sku: 'X', quantity: 0 }, { sku: 'Y', quantity: -2 },
      { sku: 'Z', quantity: 'abc' }, null, 'nope',
    ])).toEqual([])
    expect(parseLineItems(null)).toEqual([])
    expect(parseLineItems({ sku: 'X', quantity: 1 })).toEqual([])
  })
})

describe('isoWeekKey', () => {
  it('handles ISO year boundaries (week 1 contains the first Thursday)', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01') // Thursday
    expect(isoWeekKey(new Date('2026-01-04T00:00:00Z'))).toBe('2026-W01') // Sunday of W01
    expect(isoWeekKey(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02') // Monday
    expect(isoWeekKey(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01') // Monday of next ISO year
  })
})

describe('trailingIsoWeeks', () => {
  it('returns n consecutive distinct keys ending at the week of `end`', () => {
    const weeks = trailingIsoWeeks(NOW, 52)
    expect(weeks).toHaveLength(52)
    expect(new Set(weeks).size).toBe(52)
    expect(weeks[51]).toBe(isoWeekKey(NOW))
  })
})

describe('weeklyTotals + covFromWeeklyTotals', () => {
  it('includes zero weeks — a one-spike series is high-variability', () => {
    const weeks = trailingIsoWeeks(NOW, 4)
    const totals = weeklyTotals([{ event_date: '2026-08-05', qty: 10 }], weeks)
    expect(totals).toHaveLength(4)
    expect(totals.reduce((a, b) => a + b)).toBe(10)
    expect(totals.filter(t => t === 0)).toHaveLength(3)
    // [10,0,0,0]: mean 2.5, population sd 2.5·√3 → CoV √3
    expect(covFromWeeklyTotals(totals)).toBeCloseTo(Math.sqrt(3), 10)
  })
  it('ignores events outside the listed weeks (older or future)', () => {
    const weeks = trailingIsoWeeks(NOW, 4)
    const totals = weeklyTotals([
      { event_date: '2026-01-01', qty: 99 },  // long past
      { event_date: '2026-09-15', qty: 99 },  // future-dated (due-date reality)
      { event_date: '2026-08-07', qty: 7 },
    ], weeks)
    expect(totals.reduce((a, b) => a + b)).toBe(7)
  })
  it('is null for empty or all-zero series (caller maps to conservative var bucket)', () => {
    expect(covFromWeeklyTotals([])).toBeNull()
    expect(covFromWeeklyTotals([0, 0, 0])).toBeNull()
  })
})

describe('median', () => {
  it('odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('dltDaysFor (door REPLACES ocean+customs)', () => {
  const p = { mfg_lt: 45, ocean_lt: 21, customs_lt: 9 }
  it('uses the seed legs below the actuals threshold', () => {
    expect(dltDaysFor(p, Array(9).fill(28))).toBe(75) // 45+21+9
  })
  it('replaces ocean+customs with median(door) at >= 10 actuals', () => {
    const dlt = dltDaysFor(p, Array(10).fill(28))
    expect(dlt).toBe(73)        // 45 + 28
    expect(dlt).not.toBe(45 + 21 + 28) // NEVER mfg + ocean + door (double-count)
  })
})

describe('onOrderBySku', () => {
  const id = (s: string) => s
  it('nets linked in-transit shipment qty off open PO qty, clamped at 0', () => {
    const open = [
      { po_id: 'po1', sku: 'EBH9NA', quantity: 500 },
      { po_id: 'po2', sku: 'EBH10NA', quantity: 100 },
    ]
    const ships = [
      { sku: 'EBH9NA', qty: 200, status: 'in_transit', po_id: 'po1' },   // dedups
      { sku: 'EBH9NA', qty: 50, status: 'delivered', po_id: 'po1' },     // delivered: no
      { sku: 'EBH9NA', qty: 999, status: 'in_transit', po_id: null },    // unlinked: no
      { sku: 'EBH10NA', qty: 150, status: 'in_transit', po_id: 'po2' },  // over-ship clamps
    ]
    const m = onOrderBySku(open, ships, id)
    expect(m.get('EBH9NA')).toBe(300)
    expect(m.get('EBH10NA')).toBe(0)
  })
  it('routes alias spellings into the canonical sku', () => {
    const resolve = (s: string) => (s === '01-EBH9' ? 'EBH9NA' : s)
    const m = onOrderBySku([{ po_id: 'po1', sku: '01-EBH9', quantity: 40 }], [], resolve)
    expect(m.get('EBH9NA')).toBe(40)
    expect(m.has('01-EBH9')).toBe(false)
  })
})

describe('maxBuildableFor', () => {
  const bom = (over: Record<string, unknown>) => ({
    finished_sku: 'EBVFKNA', component_code: 'C', qty_per: 1, bamida_item_name: 'Foam',
    verified: true, last_seen_week: null, ...over,
  })
  it('MIN over verified mapped rows; negative availability clamps to 0', () => {
    const rows = [
      bom({ component_code: 'C1', bamida_item_name: 'Foam', qty_per: 2 }),
      bom({ component_code: 'C2', bamida_item_name: 'Steel', qty_per: 1 }),
      bom({ component_code: 'C3', bamida_item_name: 'Clip', qty_per: 4, verified: false }), // ignored
    ]
    const avail = new Map([['Foam', 100], ['Steel', 80], ['Clip', 4]])
    expect(maxBuildableFor(rows, avail)).toEqual({ value: 50, missingJoins: [] })
    expect(maxBuildableFor(rows, new Map([['Foam', -5], ['Steel', 80]])))
      .toEqual({ value: 0, missingJoins: [] })
  })
  it('reports vanished joins (never silent) and keeps the known-component bound', () => {
    const rows = [
      bom({ component_code: 'C1', bamida_item_name: 'Foam', qty_per: 2 }),
      bom({ component_code: 'C2', bamida_item_name: 'Ghost' }),
    ]
    expect(maxBuildableFor(rows, new Map([['Foam', 100]])))
      .toEqual({ value: 50, missingJoins: ['Ghost'] })
  })
  it('null (capacity unknown) with no verified mapped rows', () => {
    expect(maxBuildableFor([bom({ verified: false })], new Map())).toEqual({ value: null, missingJoins: [] })
    expect(maxBuildableFor([], new Map())).toEqual({ value: null, missingJoins: [] })
  })
})

// ---------------------------------------------------------------------------
// Full engine run over one rich fixture
// ---------------------------------------------------------------------------

function richFixture(): Partial<Fixtures> {
  return {
    profiles: [
      profile({ sku: 'EBH9NA' }),
      profile({ sku: 'EBVFKNA' }),
      profile({ sku: 'EBH8NA', seeded: false }),
      profile({ sku: 'H8', alias_of: 'EBH8NA', seeded: false }),
    ],
    demandEvents: [
      { event_date: '2026-07-01', sku: 'EBH9NA', qty: 162, source: 'xero_invoice' },
      { event_date: '2026-08-01', sku: 'EBH9NA', qty: 18, source: 'hubspot_deal' }, // firm (≤14d)
      { event_date: '2026-07-01', sku: 'EBVFKNA', qty: 180, source: 'xero_invoice' },
      { event_date: '2026-06-01', sku: 'H8', qty: 53, source: 'hubspot_deal' },     // alias spelling
      { event_date: '2025-06-01', sku: 'EBH9NA', qty: 999, source: 'xero_invoice' }, // outside 180d+CoV
    ],
    stockLevels: [
      { warehouse_code: 'US-BAL', sku: 'EBH9NA', quantity_on_hand: 40, last_counted_at: null },
      { warehouse_code: 'CA-HAM', sku: 'EBH9NA', quantity_on_hand: 10, last_counted_at: null },
    ],
    shipments: [
      { sku: 'EBH9NA', qty: 30, status: 'in_transit', po_id: null },
      { sku: 'EBH9NA', qty: 20, status: 'in_transit', po_id: 'po1' }, // dedups on_order
    ],
    openPoLines: [{ po_id: 'po1', sku: 'EBH9NA', quantity: 100 }],
    stageWeights: [
      { stage_id: 'late-stage', win_weight: 0.9, is_late_stage: true },
      { stage_id: 'early-stage', win_weight: 0.2, is_late_stage: false },
    ],
    openDeals: [
      { hubspot_deal_id: 'D1', deal_status: 'late-stage', line_items_raw: [{ sku: 'EBVFKNA', quantity: 30 }] },
      { hubspot_deal_id: 'D2', deal_status: 'late-stage', line_items_raw: [{ sku: 'EBVFKNA', quantity: 10 }] }, // < 0.5×red
      { hubspot_deal_id: 'D3', deal_status: 'late-stage', line_items_raw: [{ sku: 'H8', quantity: 100 }] },     // unseeded target
      { hubspot_deal_id: 'D4', deal_status: 'early-stage', line_items_raw: [{ sku: 'EBVFKNA', quantity: 500 }] }, // not late
    ],
    closedWonDeals: [
      { hubspot_deal_id: 'CW1', deal_status: 'closedwon', line_items_raw: [{ sku: 'EBH9NA', quantity: 5 }] }, // gap
      { hubspot_deal_id: 'CW2', deal_status: 'closedwon', line_items_raw: [{ sku: 'EBH9NA', quantity: 7 }] }, // captured
    ],
    hubspotDemandDealIds: ['CW2'],
    bomMap: [
      { finished_sku: 'EBVFKNA', component_code: 'C1', qty_per: 2, bamida_item_name: 'Foam', verified: true, last_seen_week: '2026-08-03' },
      { finished_sku: 'EBVFKNA', component_code: 'C2', qty_per: 1, bamida_item_name: 'Ghost', verified: true, last_seen_week: '2026-08-03' },
      { finished_sku: 'EBH9NA', component_code: 'C3', qty_per: 1, bamida_item_name: null, verified: false, last_seen_week: '2026-07-27' }, // stale
    ],
    materialStock: [{ item_name: 'Foam', available_quantity: 100 }],
    receiptRows: [
      { depot: 'US-BAL', sku: 'EBH9NA', qty: 40 },  // matches stock
      { depot: 'CA-HAM', sku: 'EBH9NA', qty: 10 },  // matches stock
      { depot: 'US-BAL', sku: 'EBVFKNA', qty: 7 },  // no stock row → drift
    ],
  }
}

describe('runMrpEngine (stubbed end-to-end)', () => {
  it('assembles per-SKU rows, routes aliases, qualifies spikes, and flags states', async () => {
    const { data, captured } = makeData(richFixture())
    const res = await runMrpEngine(data, { now: NOW })

    // Alias rows are excluded from computation and persistence.
    expect(res.skus).toBe(3)
    expect(res.rows.map(r => r.sku).sort()).toEqual(['EBH8NA', 'EBH9NA', 'EBVFKNA'])
    expect(res.run_date).toBe('2026-08-08')

    const h9 = res.rows.find(r => r.sku === 'EBH9NA')!
    // ADU: (162 + 18) / 180 = 1.0 — the 2025 event is outside the window.
    // Flow: on_hand 40+10, in_transit 30+20, on_order 100−20, firm 18.
    expect(h9.on_hand).toBe(50)
    expect(h9.in_transit).toBe(50)
    expect(h9.on_order).toBe(80)
    expect(h9.firm_demand).toBe(18)
    expect(h9.nfp).toBe(50 + 50 + 80 - 18)
    // adu 1.0, dlt 75, lt 0.25 → yellow 75, redBase 18.75; spiky CoV → vf 1.0
    // → red 38, yellowTop 113, greenTop 132. NFP 162 > 113 → green.
    expect(h9.red).toBe(38)
    expect(h9.yellow_top).toBe(113)
    expect(h9.green_top).toBe(132)
    expect(h9.zone).toBe('green')
    expect(h9.action_qty).toBe(0)
    expect(h9.max_buildable).toBeNull()
    expect(h9.flags).toContain('materials_unverified')
    expect(h9.flags).toContain('stock_unverified')   // every last_counted_at null
    expect(h9.flags).toContain('demand_capture_gap') // CW1 never hit the ledger
    expect(h9.flags).toContain('bom_map_stale')

    const vfk = res.rows.find(r => r.sku === 'EBVFKNA')!
    // Same demand shape → same zones; zero flow → NFP 0 → red, action 132.
    expect(vfk.zone).toBe('red')
    expect(vfk.nfp).toBe(0)
    expect(vfk.action_qty).toBe(132)
    // Spikes: D1 (30 ≥ 0.5×38) qualifies at weight 0.9; D2 too small; D4 not late.
    expect(res.spikes).toEqual([{
      run_date: '2026-08-08', deal_id: 'D1', sku: 'EBVFKNA', qty: 30,
      due_date: null, weight: 0.9, qualified: true,
    }])
    expect(vfk.qualified_spikes).toBeCloseTo(27, 10)
    expect(vfk.projected_nfp).toBeCloseTo(-27, 10)
    // Materials: Foam bounds 100/2 = 50 < action 132 → blocked; Ghost is warned.
    expect(vfk.max_buildable).toBe(50)
    expect(vfk.blocked_by_materials).toBe(true)
    expect(vfk.flags).toContain('stock_drift')
    expect(res.warnings).toContain('bom_join_missing:EBVFKNA:Ghost')
    expect(res.warnings).toContain('stock_drift:EBVFKNA')
    expect(res.warnings).toContain('demand_capture_gap:CW1')
    expect(res.warnings).toContain('bom_map_stale:1 rows')

    // Unseeded SKU: binding spike guard — no register rows even though D3
    // targets it via the H8 alias; both state flags land for the shadow board.
    const h8 = res.rows.find(r => r.sku === 'EBH8NA')!
    expect(h8.flags).toContain('buffers_unseeded')
    expect(h8.flags).toContain('spikes_skipped_no_buffer')
    expect(h8.flags).toContain('thin_history') // 1 aliased event < 5
    expect(res.spikes.some(s => s.sku === 'EBH8NA')).toBe(false)
    // …but the aliased demand still rolled into its ADU-side aggregation
    // (event under 'H8' — visible through firm-demand exclusion + thin count).
    expect(h8.firm_demand).toBe(0) // H8 event is 2026-06-01, outside 14d

    // Persistence: status upserted once, write-backs carry engine-owned stats.
    expect(captured.status).toHaveLength(1)
    expect(captured.spikes).toHaveLength(1)
    const wb = captured.writeBacks[0].find(w => w.sku === 'EBH9NA')!
    expect(wb.adu).toBe(1)
    expect(wb.dlt_days).toBe(75)
    expect(wb.seeded).toBe(true)
    expect(wb.var_factor).toBe(1)
    expect(typeof wb.updated_at).toBe('string') // set explicitly — no touch trigger
    expect(res.blocked).toBe(1)
    expect(res.reds).toBe(2) // EBVFKNA + unseeded zero-flow EBH8NA (red, action ceil'd)
  })

  it('dryRun computes everything but never persists', async () => {
    const { data, captured } = makeData(richFixture())
    const res = await runMrpEngine(data, { now: NOW, dryRun: true })
    expect(res.skus).toBe(3)
    expect(captured.status).toHaveLength(0)
    expect(captured.spikes).toHaveLength(0)
    expect(captured.writeBacks).toHaveLength(0)
  })

  it('leaves manual ADU alone: zones use the override and write-back omits adu/cov', async () => {
    const { data, captured } = makeData({
      profiles: [profile({ sku: 'EBH9NA', adu_source: 'manual', adu: 2, var_factor: 0.4 })],
      demandEvents: [{ event_date: '2026-07-01', sku: 'EBH9NA', qty: 900, source: 'xero_invoice' }],
    })
    const res = await runMrpEngine(data, { now: NOW })
    const row = res.rows[0]
    // manual adu 2 (not 900/180=5) with pinned var_factor 0.4:
    // yellow 150, redBase 37.5, red ceil(37.5·1.4)=53
    expect(row.red).toBe(53)
    expect(row.yellow_top).toBe(203)
    const wb = captured.writeBacks[0][0]
    expect(wb.adu).toBeUndefined()
    expect(wb.cov).toBeUndefined()
    expect(wb.var_factor).toBeUndefined()
    expect(wb.dlt_days).toBe(75) // DLT still recalibrates for manual rows
  })

  it('notes the empty late-stage allowlist gracefully (no candidates, no crash)', async () => {
    const { data } = makeData({
      profiles: [profile({ sku: 'EBH9NA' })],
      stageWeights: [{ stage_id: 'closedwon', win_weight: 1, is_late_stage: true }],
      openDeals: [{ hubspot_deal_id: 'D1', deal_status: 'some-open-stage', line_items_raw: [{ sku: 'EBH9NA', quantity: 50 }] }],
    })
    const res = await runMrpEngine(data, { now: NOW })
    expect(res.warnings).toContain('no_late_stage_allowlist_for_open_deals')
    expect(res.spikes).toEqual([])
  })

  it('firm demand counts only hubspot_deal events inside the 14d window', async () => {
    const { data } = makeData({
      profiles: [profile({ sku: 'EBH9NA' })],
      demandEvents: [
        { event_date: '2026-08-01', sku: 'EBH9NA', qty: 10, source: 'hubspot_deal' },  // in
        { event_date: '2026-07-20', sku: 'EBH9NA', qty: 99, source: 'hubspot_deal' },  // out (>14d)
        { event_date: '2026-08-01', sku: 'EBH9NA', qty: 77, source: 'xero_invoice' },  // wrong source
      ],
    })
    const res = await runMrpEngine(data, { now: NOW })
    expect(res.rows[0].firm_demand).toBe(10)
  })

  it('includes future-dated events in ADU (due-date reality) but not CoV weeks', async () => {
    const { data, captured } = makeData({
      profiles: [profile({ sku: 'EBH8NA' })],
      demandEvents: [{ event_date: '2026-09-15', sku: 'EBH8NA', qty: 18, source: 'xero_invoice' }],
    })
    await runMrpEngine(data, { now: NOW })
    const wb = captured.writeBacks[0][0]
    expect(wb.adu).toBe(0.1)     // 18/180 — invisible-until-due would be 0
    expect(wb.cov).toBeNull()    // no realized weeks → undefined CoV
    expect(wb.var_factor).toBe(1) // null CoV → most conservative bucket
  })
})
