import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A container arrives: the barriers leave s.r.o. and land at the depot the
 * closer chose. Dean, 21 Sep 2026.
 *
 * The fake below is a small relational store rather than a recorder of calls,
 * so the assertions are about what the ledger and the tables end up holding.
 */

type Row = Record<string, unknown>
const db: {
  orders: Row[]
  lines: Row[]
  manufacturing: Row[]
  receipts: Row[]
  contents: Row[]
  ledger: Row[]
  ledgerKeys: Set<string>
  failLedger: boolean
} = { orders: [], lines: [], manufacturing: [], receipts: [], contents: [], ledger: [], ledgerKeys: new Set(), failLedger: false }

function table(name: string): Row[] {
  return (
    {
      purchase_orders: db.orders,
      purchase_order_lines: db.lines,
      po_manufacturing: db.manufacturing,
      po_line_receipts: db.receipts,
      shipment_contents: db.contents,
      mrp_lead_time_actuals: [],
    } as Record<string, Row[]>
  )[name]
}

function builder(name: string) {
  const rows = table(name)
  const filters: ((r: Row) => boolean)[] = []
  let update: Row | null = null
  let wantSelect = false
  const matched = () => rows.filter((r) => filters.every((f) => f(r)))
  const hydrate = (r: Row) =>
    name === 'purchase_orders' ? { ...r, lines: db.lines.filter((l) => l.po_id === r.id) } : r
  const run = () => {
    if (update) {
      const hit = matched()
      for (const r of hit) Object.assign(r, update)
      return { data: wantSelect ? hit.map((r) => ({ id: r.id })) : null, error: null }
    }
    return { data: matched().map(hydrate), error: null }
  }
  const api = {
    select: () => { wantSelect = true; return api },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api },
    neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return api },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return api },
    update: (patch: Row) => { update = patch; return api },
    insert: async (payload: Row[]) => { rows.push(...payload.map((r, i) => ({ id: `${name}-${rows.length + i}`, ...r }))); return { error: null } },
    maybeSingle: async () => ({ data: matched().map(hydrate)[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => ok(run()),
  }
  return api
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
const admin = {
  from: (name: string) => builder(name),
  rpc: async (fn: string, args: { p_rows: Row[]; p_uid: string | null }) => {
    if (fn !== 'hub_apply_stock_movements') throw new Error(`unexpected rpc ${fn}`)
    if (db.failLedger) return { data: null, error: { message: 'boom' } }
    let applied = 0
    let skipped = 0
    for (const r of args.p_rows) {
      const key = [r.kind, r.ref_type, r.ref_id, r.warehouse_code, r.sku].join('|')
      if (db.ledgerKeys.has(key)) { skipped++; continue }
      db.ledgerKeys.add(key)
      db.ledger.push({ ...r, uid: args.p_uid })
      applied++
    }
    return { data: { applied, skipped }, error: null }
  },
}

const { arriveAtDepot } = await import('@/lib/stock/arrival')
// The fake speaks the five verbs the module uses and nothing else; the cast is
// the test's own business, not the module's.
const client = admin as unknown as Parameters<typeof arriveAtDepot>[0]

const NOW = '2026-09-21T09:00:00Z'
const chain = () => {
  db.orders = [
    { id: 'depot', leg: 'DEPOT_TO_EB_GROUP', status: 'approved', source: 'hub', master_ref: 'MR-1', from_entity: 'US-BAL' },
    { id: 'sro', leg: 'EB_GROUP_TO_SRO', status: 'ready_for_shipment', source: 'hub', master_ref: 'MR-1', from_entity: 'EB-GROUP' },
    { id: 'bamida', leg: 'SRO_TO_SUPPLIER', status: 'approved', source: 'hub', master_ref: 'MR-1', from_entity: 'EB-SRO' },
  ]
  db.lines = [
    { id: 'd1', po_id: 'depot', sku: 'EBH9NA', quantity: 300 },
    { id: 'd2', po_id: 'depot', sku: 'EBH10NA', quantity: 60 },
    { id: 's1', po_id: 'sro', sku: 'EBH9NA', quantity: 300 },
    { id: 's2', po_id: 'sro', sku: 'EBH10NA', quantity: 60 },
    { id: 'b1', po_id: 'bamida', sku: 'EBH9NA', quantity: 300 },
  ]
  db.manufacturing = [{ po_id: 'bamida', finished_at: '2026-09-20T10:00:00Z' }]
  db.receipts = []
  db.contents = [{ id: 'c1', po_id: 'sro', status: 'on_water', spot_id: null, shipped_at: null }]
  db.ledger = []
  db.ledgerKeys = new Set()
  db.failLedger = false
}
beforeEach(chain)

const balance = (wh: string, sku: string) =>
  db.ledger.filter((r) => r.warehouse_code === wh && r.sku === sku).reduce((a, r) => a + Number(r.quantity), 0)

describe('arriveAtDepot', () => {
  it('moves the whole order from s.r.o. to the chosen depot, and closes the chain', async () => {
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(res).toMatchObject({ ok: true, depot: 'US-BAL', units: 360, leftSro: { applied: 2, skipped: 0 }, receivingLegId: 'depot' })
    expect(balance('EB-SRO', 'EBH9NA')).toBe(-300)
    expect(balance('EB-SRO', 'EBH10NA')).toBe(-60)
    expect(balance('US-BAL', 'EBH9NA')).toBe(300)
    expect(balance('US-BAL', 'EBH10NA')).toBe(60)
    // The audit trail and the guard against a second, line-by-line receipt.
    expect(db.receipts.map((r) => [r.po_line_id, r.qty_received, r.batch_ref])).toEqual([
      ['d1', 300, 'ARRIVAL US-BAL'],
      ['d2', 60, 'ARRIVAL US-BAL'],
    ])
    expect(db.orders.find((o) => o.id === 'depot')).toMatchObject({ status: 'delivered', delivered_at: NOW })
    expect(db.orders.find((o) => o.id === 'sro')).toMatchObject({ status: 'delivered' })
    expect(db.orders.find((o) => o.id === 'bamida')?.status).toBe('approved')
    expect(db.contents[0]).toMatchObject({ status: 'delivered', delivered_at: NOW })
    expect(db.ledger.every((r) => r.uid === 'juraj')).toBe(true)
  })

  it('lets the closer choose a depot other than the one that ordered', async () => {
    const res = await arriveAtDepot(client, { poId: 'depot', depot: 'GB-BSE', uid: 'juraj', nowIso: NOW })
    expect(res.ok).toBe(true)
    expect(balance('GB-BSE', 'EBH9NA')).toBe(300)
    expect(balance('US-BAL', 'EBH9NA')).toBe(0)
  })

  it('does not deduct s.r.o. twice when a Cargo Partner booking already did', async () => {
    // What the trigger wrote: same kind, same ref_type, same ref_id, same place, same SKU.
    for (const sku of ['EBH9NA', 'EBH10NA']) db.ledgerKeys.add(['shipped_out', 'po_shipment', 'sro', 'EB-SRO', sku].join('|'))
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(res).toMatchObject({ ok: true, leftSro: { applied: 0, skipped: 2 } })
    expect(balance('EB-SRO', 'EBH9NA')).toBe(0)
    expect(balance('US-BAL', 'EBH9NA')).toBe(300)
  })

  it('only lands what is still outstanding after a partial delivery logged the long way', async () => {
    db.receipts = [{ id: 'r-old', po_id: 'depot', po_line_id: 'd1', qty_received: 100 }]
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(res).toMatchObject({ ok: true, units: 260 })
    expect(balance('US-BAL', 'EBH9NA')).toBe(200)
    expect(balance('US-BAL', 'EBH10NA')).toBe(60)
  })

  it('refuses a second arrival', async () => {
    expect((await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })).ok).toBe(true)
    const again = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(again.ok).toBe(false)
    expect(balance('US-BAL', 'EBH9NA')).toBe(300)
  })

  it('refuses before Bamida have marked the order finished, so EB-SRO never goes negative', async () => {
    db.manufacturing = [{ po_id: 'bamida', finished_at: null }]
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/finished/)
    expect(db.ledger).toEqual([])
    expect(db.receipts).toEqual([])
  })

  it('handles a refill raised by s.r.o. itself, which has no depot order above it', async () => {
    db.orders = [
      { id: 'sro', leg: 'EB_GROUP_TO_SRO', status: 'ready_for_shipment', source: 'hub', master_ref: 'MR-2', from_entity: 'EB-GROUP' },
    ]
    db.lines = [{ id: 's1', po_id: 'sro', sku: 'EBH9NA', quantity: 120 }]
    db.manufacturing = []
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'EU-FR', uid: 'juraj', nowIso: NOW })
    expect(res).toMatchObject({ ok: true, units: 120, receivingLegId: 'sro' })
    expect(balance('EB-SRO', 'EBH9NA')).toBe(-120)
    expect(balance('EU-FR', 'EBH9NA')).toBe(120)
    expect(db.orders[0]).toMatchObject({ status: 'delivered' })
  })

  it('refuses a place that is not a depot, and a chain with no s.r.o. leg', async () => {
    expect((await arriveAtDepot(client, { poId: 'sro', depot: 'EB-SRO', uid: 'j', nowIso: NOW })).ok).toBe(false)
    expect((await arriveAtDepot(client, { poId: 'sro', depot: 'EB-GROUP', uid: 'j', nowIso: NOW })).ok).toBe(false)
    db.orders = db.orders.filter((o) => o.leg !== 'EB_GROUP_TO_SRO')
    expect((await arriveAtDepot(client, { poId: 'depot', depot: 'US-BAL', uid: 'j', nowIso: NOW })).ok).toBe(false)
    expect(db.ledger).toEqual([])
  })

  it('writes nothing else when the ledger refuses, so a retry starts clean', async () => {
    db.failLedger = true
    const res = await arriveAtDepot(client, { poId: 'sro', depot: 'US-BAL', uid: 'juraj', nowIso: NOW })
    expect(res.ok).toBe(false)
    expect(db.receipts).toEqual([])
    expect(db.orders.find((o) => o.id === 'depot')?.status).toBe('approved')
  })
})

describe('the endpoint in front of it', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('checks the session, a capability and the chain before the depot even parses', () => {
    const src = read('src/app/actions/purchase-orders/arrive-at-depot.ts')
    expect(src).toContain("'use server'")
    expect(src).toContain("auth.capabilities.has('stock.edit') && !auth.capabilities.has('po.receive')")
    expect(src).toContain('poChainHeldBy(parsed.data.poId, auth.profile.organisations)')
    expect(src).toContain('z.enum(ARRIVAL_DEPOTS)')
    expect(src.indexOf('getAuthorizedUser')).toBeLessThan(src.indexOf('arriveAtDepot(createAdminClient()'))
  })

  it('names no ledger RPC of its own', () => {
    // src/lib/stock/apply.ts is the only file allowed to; stock-write-guard
    // enforces it, this just says so next to the code it is about.
    expect(read('src/lib/stock/arrival.ts')).not.toMatch(/rpc\(/)
  })
})
