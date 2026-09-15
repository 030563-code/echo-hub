import 'server-only'

/**
 * The reads behind the stock board. Admin client, called by server components
 * that have already passed the page gate (stock.view or stock.edit), the same
 * shape as the invoicing stage queue.
 *
 * On hand is the balance table. Committed, in production and inbound are
 * derived from orders and invoices on every read (see positions.ts for the
 * definitions), so there is no second copy of the truth to drift.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { deriveFinishedPositions, type FinishedPosition, type InboundRow } from '@/lib/stock/positions'
import { findLedgerGaps, type LedgerGap } from '@/lib/stock/reconcile'
import { SRO_WAREHOUSE } from '@/lib/stock/warehouses'
import { suppliedRequirementForLines } from '@/lib/mrp/supplied-materials'
import type { MovementKind, ItemKind } from '@/lib/stock/movements'

type Admin = ReturnType<typeof createAdminClient>

/** master_refs of chains that have a Cargo Partner SPOT id somewhere. */
async function bookedChains(admin: Admin): Promise<Set<string>> {
  const { data: spots } = await admin.from('po_shipments').select('po_id').not('spot_id', 'is', null)
  const ids = (spots ?? []).map((s) => String(s.po_id))
  if (ids.length === 0) return new Set()
  const { data: pos } = await admin.from('purchase_orders').select('master_ref').in('id', ids)
  return new Set((pos ?? []).map((p) => String(p.master_ref ?? '')).filter(Boolean))
}

/**
 * The finished-goods positions, for the given warehouses only when a list is
 * passed: an organisation's board shows its own warehouses and no other's. The
 * committed and inbound figures are derived per warehouse, so the positions
 * are filtered to the same list before they leave here.
 */
export async function loadFinishedBoard(now = new Date(), warehouses?: readonly string[]): Promise<FinishedPosition[]> {
  const admin = createAdminClient()
  const booked = await bookedChains(admin)

  const levelColumns = 'warehouse_code, sku, product_name, quantity_on_hand, last_counted_at'
  const [levels, sroReady, bamida, invoiceLines, depotOrders] = await Promise.all([
    warehouses
      ? admin.from('warehouse_stock_levels').select(levelColumns).in('warehouse_code', [...warehouses])
      : admin.from('warehouse_stock_levels').select(levelColumns),
    admin
      .from('purchase_orders')
      .select('master_ref, parent_po_id, lines:purchase_order_lines(sku, quantity)')
      .eq('leg', 'EB_GROUP_TO_SRO')
      .eq('status', 'ready_for_shipment'),
    admin
      .from('purchase_orders')
      .select('status, lines:purchase_order_lines(sku, quantity), manufacturing:po_manufacturing(finished_at)')
      .eq('leg', 'SRO_TO_SUPPLIER')
      .not('status', 'in', '("cancelled","delivered","rejected")'),
    admin
      .from('customer_invoice_lines')
      .select('sku, quantity, is_shipping, ship_from_depot, invoice:customer_invoices!inner(status)')
      .in('invoice.status', ['tax_calculated', 'filed', 'documented']),
    admin
      .from('purchase_orders')
      .select('id, master_ref, from_entity, lines:purchase_order_lines(id, sku, quantity)')
      .eq('leg', 'DEPOT_TO_EB_GROUP')
      .eq('source', 'hub')
      .eq('status', 'approved'),
  ])

  // Received so far, per depot order line, to net off the inbound figure.
  const lineIds = (depotOrders.data ?? []).flatMap((o) => (o.lines ?? []).map((l) => String(l.id)))
  const receivedByLine = new Map<string, number>()
  if (lineIds.length > 0) {
    const { data: receipts } = await admin
      .from('po_line_receipts')
      .select('po_line_id, qty_received')
      .in('po_line_id', lineIds)
    for (const r of receipts ?? []) {
      const id = String(r.po_line_id)
      receivedByLine.set(id, (receivedByLine.get(id) ?? 0) + Number(r.qty_received ?? 0))
    }
  }

  // A rootless SRO order (no depot behind it) is a refill of the s.r.o. shelf,
  // loaded by the warm start for orders like the UK H9 refills: nothing is
  // committed to anyone, so it never counts here.
  const sroCommitted = (sroReady.data ?? [])
    .filter((o) => o.parent_po_id !== null)
    .filter((o) => !booked.has(String(o.master_ref ?? '')))
    .flatMap((o) => (o.lines ?? []).map((l) => ({ sku: String(l.sku ?? ''), quantity: Number(l.quantity ?? 0) })))

  const inProduction = (bamida.data ?? [])
    .filter((o) => {
      const m = o.manufacturing as { finished_at: string | null } | { finished_at: string | null }[] | null
      const row = Array.isArray(m) ? m[0] : m
      return !row?.finished_at
    })
    .flatMap((o) => (o.lines ?? []).map((l) => ({ sku: String(l.sku ?? ''), quantity: Number(l.quantity ?? 0) })))

  const depotCommitted = (invoiceLines.data ?? [])
    .filter((l) => !l.is_shipping)
    .map((l) => ({
      warehouse_code: String(l.ship_from_depot ?? ''),
      sku: String(l.sku ?? ''),
      quantity: Number(l.quantity ?? 0),
    }))

  const inbound: InboundRow[] = (depotOrders.data ?? []).flatMap((o) =>
    (o.lines ?? []).map((l) => ({
      warehouse_code: String(o.from_entity ?? ''),
      sku: String(l.sku ?? ''),
      outstanding: Number(l.quantity ?? 0) - (receivedByLine.get(String(l.id)) ?? 0),
      in_transit: booked.has(String(o.master_ref ?? '')),
    })),
  )

  const positions = deriveFinishedPositions(
    {
      levels: (levels.data ?? []).map((l) => ({
        warehouse_code: String(l.warehouse_code),
        sku: String(l.sku),
        product_name: l.product_name ?? null,
        quantity_on_hand: Number(l.quantity_on_hand ?? 0),
        last_counted_at: l.last_counted_at ?? null,
      })),
      sroCommitted,
      inProduction,
      depotCommitted,
      inbound,
      sroWarehouse: SRO_WAREHOUSE,
    },
    now,
  )
  return warehouses ? positions.filter((p) => warehouses.includes(p.warehouse_code)) : positions
}

export interface MaterialPosition {
  component_code: string
  description: string | null
  unit: string | null
  on_hand: number
  /** Recipe applied to every Bamida order not yet finished: spoken for, still on the shelf. */
  committed: number
  /** on_hand minus committed. Negative is shown, not clamped. */
  available: number
  /** Open material_orders rows: bought, not yet received. */
  on_order: number
  /** Estimated consumption written since the last count (a negative number). */
  estimated_since_count: number
  last_counted_at: string | null
  bamida_item_name: string | null
  bamida_quantity: number | null
  bamida_unit: string | null
  bamida_synced_at: string | null
}

export async function loadMaterialsBoard(): Promise<MaterialPosition[]> {
  const admin = createAdminClient()
  const [levels, bomNames, estimated, openBamida, onOrder] = await Promise.all([
    admin
      .from('material_stock_levels')
      .select('component_code, description, unit, quantity, last_counted_at')
      .eq('warehouse_code', SRO_WAREHOUSE)
      .order('component_code'),
    admin.from('mrp_bom_map').select('finished_sku, component_code, component_desc, qty_per, bamida_item_name'),
    admin
      .from('stock_movements')
      .select('sku, quantity, created_at')
      .eq('item_kind', 'material')
      .eq('warehouse_code', SRO_WAREHOUSE)
      .eq('estimated', true),
    admin
      .from('purchase_orders')
      .select('lines:purchase_order_lines(sku, quantity), manufacturing:po_manufacturing(finished_at)')
      .eq('leg', 'SRO_TO_SUPPLIER')
      .not('status', 'in', '("cancelled","delivered","rejected")'),
    admin
      .from('material_orders')
      .select('component_code, quantity')
      .eq('warehouse_code', SRO_WAREHOUSE)
      .is('received_at', null),
  ])

  // Committed: the recipe applied to every Bamida order not yet finished.
  const openLines = (openBamida.data ?? [])
    .filter((o) => {
      const m = o.manufacturing as { finished_at: string | null } | { finished_at: string | null }[] | null
      const row = Array.isArray(m) ? m[0] : m
      return !row?.finished_at
    })
    .flatMap((o) => (o.lines ?? []).map((l) => ({ sku: String(l.sku ?? ''), quantity: Number(l.quantity ?? 0) })))
  const committedByCode = suppliedRequirementForLines(
    (bomNames.data ?? []).map((r) => ({
      finished_sku: String(r.finished_sku ?? ''),
      component_code: String(r.component_code ?? ''),
      component_desc: r.component_desc ?? null,
      qty_per: Number(r.qty_per ?? 0),
    })),
    openLines,
  )
  const onOrderByCode = new Map<string, number>()
  for (const o of onOrder.data ?? []) {
    const code = String(o.component_code)
    onOrderByCode.set(code, (onOrderByCode.get(code) ?? 0) + Number(o.quantity ?? 0))
  }

  // One Bamida card name per component, where the recipe names one.
  const bamidaNameByCode = new Map<string, string>()
  const descByCode = new Map<string, string>()
  for (const r of bomNames.data ?? []) {
    const code = String(r.component_code)
    if (r.bamida_item_name && !bamidaNameByCode.has(code)) bamidaNameByCode.set(code, String(r.bamida_item_name))
    if (r.component_desc && !descByCode.has(code)) descByCode.set(code, String(r.component_desc))
  }
  const names = [...new Set(bamidaNameByCode.values())]
  const bamidaByName = new Map<string, { quantity: number; unit: string | null; synced: string | null }>()
  if (names.length > 0) {
    const { data: cards } = await admin
      .from('bamida_material_stock')
      .select('item_name, quantity, unit, last_synced_at')
      .in('item_name', names)
    for (const c of cards ?? []) {
      bamidaByName.set(String(c.item_name), {
        quantity: Number(c.quantity ?? 0),
        unit: c.unit ?? null,
        synced: c.last_synced_at ?? null,
      })
    }
  }

  return (levels.data ?? []).map((l) => {
    const code = String(l.component_code)
    const since = l.last_counted_at ? Date.parse(String(l.last_counted_at)) : Number.NEGATIVE_INFINITY
    const est = (estimated.data ?? [])
      .filter((m) => String(m.sku) === code && Date.parse(String(m.created_at)) > since)
      .reduce((sum, m) => sum + Number(m.quantity ?? 0), 0)
    const bamidaName = bamidaNameByCode.get(code) ?? null
    const card = bamidaName ? bamidaByName.get(bamidaName) : undefined
    const onHand = Number(l.quantity ?? 0)
    const committed = committedByCode.get(code) ?? 0
    return {
      component_code: code,
      description: l.description ?? descByCode.get(code) ?? null,
      unit: l.unit ?? null,
      on_hand: onHand,
      committed,
      available: Math.round((onHand - committed) * 1000) / 1000,
      on_order: Math.round((onOrderByCode.get(code) ?? 0) * 1000) / 1000,
      estimated_since_count: Math.round(est * 1000) / 1000,
      last_counted_at: l.last_counted_at ?? null,
      bamida_item_name: bamidaName,
      bamida_quantity: card?.quantity ?? null,
      bamida_unit: card?.unit ?? null,
      bamida_synced_at: card?.synced ?? null,
    }
  })
}

export interface MovementRow {
  id: string
  item_kind: ItemKind
  warehouse_code: string
  sku: string
  kind: MovementKind
  quantity: number
  balance_after: number
  ref_type: string
  ref_id: string
  estimated: boolean
  note: string | null
  created_by: string | null
  created_at: string
}

export async function loadMovements(opts: {
  warehouse?: string
  /** The organisation's warehouses: the outer scope, applied whether or not
   *  one warehouse is picked within it. */
  warehouses?: readonly string[]
  sku?: string
  itemKind?: ItemKind
  limit?: number
}): Promise<MovementRow[]> {
  const admin = createAdminClient()
  let q = admin
    .from('stock_movements')
    .select('id, item_kind, warehouse_code, sku, kind, quantity, balance_after, ref_type, ref_id, estimated, note, created_by_uid, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500))
  if (opts.warehouses) q = q.in('warehouse_code', [...opts.warehouses])
  if (opts.warehouse) q = q.eq('warehouse_code', opts.warehouse)
  if (opts.sku) q = q.eq('sku', opts.sku)
  if (opts.itemKind) q = q.eq('item_kind', opts.itemKind)
  const { data } = await q

  // Names for whoever pressed the button. Null uid means the Hub itself (a
  // trigger, a feed, a script).
  const uids = [...new Set((data ?? []).map((m) => m.created_by_uid).filter((u): u is string => Boolean(u)))]
  const nameByUid = new Map<string, string>()
  if (uids.length > 0) {
    const { data: profiles } = await admin.from('profiles').select('id, display_name').in('id', uids)
    for (const p of profiles ?? []) {
      nameByUid.set(String(p.id), String(p.display_name || 'someone'))
    }
  }

  return (data ?? []).map((m) => ({
    id: String(m.id),
    item_kind: m.item_kind as ItemKind,
    warehouse_code: String(m.warehouse_code),
    sku: String(m.sku),
    kind: m.kind as MovementKind,
    quantity: Number(m.quantity),
    balance_after: Number(m.balance_after),
    ref_type: String(m.ref_type),
    ref_id: String(m.ref_id),
    estimated: m.estimated === true,
    note: m.note ?? null,
    created_by: m.created_by_uid ? (nameByUid.get(String(m.created_by_uid)) ?? 'someone') : null,
    created_at: String(m.created_at),
  }))
}

/**
 * Ledger gaps for the Reconciliation tab: events that should have moved stock
 * and did not (see reconcile.ts). Reads the four event sources and the
 * distinct movement refs, hands them to the pure matcher.
 */
export async function loadReconciliation(): Promise<LedgerGap[]> {
  const admin = createAdminClient()
  const [invoices, spots, finished, receipts, movements] = await Promise.all([
    admin
      .from('customer_invoices')
      .select('id, invoice_number, status, emailed_at, updated_at, lines:customer_invoice_lines(sku, is_shipping)')
      .in('status', ['sent', 'authorizing', 'completed']),
    admin.from('po_shipments').select('po_id, spot_id, created_at').not('spot_id', 'is', null),
    admin
      .from('po_manufacturing')
      .select('po_id, finished_at, order:purchase_orders!inner(po_number)')
      .not('finished_at', 'is', null),
    admin
      .from('po_line_receipts')
      .select('id, qty_received, received_at, line:purchase_order_lines!inner(sku, order:purchase_orders!inner(po_number))'),
    admin.from('stock_movements').select('kind, ref_type, ref_id'),
  ])

  // A spot can sit on any PO of the chain; the deduction is keyed on the SRO
  // order, so resolve every booked PO to the SRO order of its chain.
  const bookedPoIds = [...new Set((spots.data ?? []).map((s) => String(s.po_id)))]
  const bookedSro: { id: string; po_number: string | null; spot_id: string; since: string | null }[] = []
  if (bookedPoIds.length > 0) {
    const { data: pos } = await admin.from('purchase_orders').select('id, master_ref, leg, po_number').in('id', bookedPoIds)
    const refs = [...new Set((pos ?? []).map((p) => String(p.master_ref ?? '')).filter(Boolean))]
    const { data: sroLegs } = refs.length
      ? await admin.from('purchase_orders').select('id, master_ref, po_number').eq('leg', 'EB_GROUP_TO_SRO').in('master_ref', refs)
      : { data: [] as { id: string; master_ref: string | null; po_number: string | null }[] }
    const sroByRef = new Map((sroLegs ?? []).map((s) => [String(s.master_ref), s]))
    const seen = new Set<string>()
    for (const s of spots.data ?? []) {
      const po = (pos ?? []).find((p) => String(p.id) === String(s.po_id))
      const sro = po ? sroByRef.get(String(po.master_ref ?? '')) : undefined
      if (!sro || seen.has(String(sro.id))) continue
      seen.add(String(sro.id))
      bookedSro.push({ id: String(sro.id), po_number: sro.po_number ?? null, spot_id: String(s.spot_id), since: s.created_at ?? null })
    }
  }

  return findLedgerGaps({
    invoices: (invoices.data ?? []).map((i) => ({
      id: String(i.id),
      invoice_number: i.invoice_number ?? null,
      status: String(i.status),
      has_goods_lines: (i.lines ?? []).some((l) => !l.is_shipping && Boolean(l.sku)),
      since: i.emailed_at ?? i.updated_at ?? null,
    })),
    bookedSroOrders: bookedSro,
    finishedBamidaOrders: (finished.data ?? []).map((f) => {
      const o = f.order as { po_number: string | null } | { po_number: string | null }[] | null
      const row = Array.isArray(o) ? o[0] : o
      return { id: String(f.po_id), po_number: row?.po_number ?? null, finished_at: String(f.finished_at) }
    }),
    receipts: (receipts.data ?? []).map((r) => {
      type Line = { sku: string | null; order: { po_number: string | null } | { po_number: string | null }[] | null }
      const raw = r.line as unknown as Line | Line[] | null
      const line = Array.isArray(raw) ? raw[0] : raw
      const order = line?.order
      const orderRow = Array.isArray(order) ? order[0] : order
      return {
        id: String(r.id),
        po_number: orderRow?.po_number ?? null,
        sku: line?.sku ?? null,
        qty_received: Number(r.qty_received ?? 0),
        received_at: r.received_at ?? null,
      }
    }),
    movements: (movements.data ?? []).map((m) => ({ kind: String(m.kind), ref_type: String(m.ref_type), ref_id: String(m.ref_id) })),
  })
}
