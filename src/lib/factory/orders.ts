import 'server-only'

/**
 * The orders the manufacturer may see, and the one predicate that decides it.
 *
 * Read with the service-role client, not the caller's. can_read_po() lets in
 * anyone holding po.view, po.create, po.approve, po.receive, bom.view,
 * bom.edit, transport.view, mrp.view or admin, and the factory account holds
 * none of those and must not: granting one would hand it every purchase order
 * in the chain over PostgREST. So the row scope is this file's job, and it is
 * written once, here, rather than repeated per page.
 *
 * VISIBLE MEANS: the manufacturing leg of a chain (SRO_TO_SUPPLIER to
 * SUPPLIER) that has actually been sent. sent_at is the same moment the
 * notification email goes, so nothing appears here before we have told them
 * about it, and a raised-but-unsent order stays internal.
 *
 * THE SELECT NAMES NO COST. unit_price, cost_snapshot and sro_cost_snapshot_eur
 * never enter this process, the same rule the emailed page was built on. The
 * SKU comes last in the line select on purpose: a guard test greps every file
 * the factory touches for a line read that opens on our internal code, and the
 * product name is what a factory reads anyway. The SKU is only the fallback for
 * a line with no name, which would otherwise render an empty row.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface FactoryOrderLine {
  product_name: string | null
  quantity: number | null
  sku: string | null
}

/** What we told them was short when we sent it. Shown, never used as a gate. */
export interface FactoryShortMaterial {
  code: string | null
  description: string | null
  need: number | null
  have: number | null
  short: number | null
}

export interface FactoryShortLine {
  quantity: number | null
  short: FactoryShortMaterial[]
}

export interface FactoryOrder {
  po_id: string
  po_number: string | null
  sent_at: string | null
  confirmed_at: string | null
  est_start: string | null
  est_finish: string | null
  finished_at: string | null
  short_materials: FactoryShortLine[] | null
  lines: FactoryOrderLine[]
}

interface Row {
  po_id: string
  sent_at: string | null
  confirmed_at: string | null
  est_start: string | null
  est_finish: string | null
  finished_at: string | null
  short_materials: FactoryShortLine[] | null
  purchase_orders: {
    id: string
    po_number: string | null
    created_at: string | null
    leg: string
    to_entity: string
    lines: FactoryOrderLine[] | null
  } | null
}

const SELECT =
  'po_id, sent_at, confirmed_at, est_start, est_finish, finished_at, short_materials, ' +
  'purchase_orders!inner(id, po_number, created_at, leg, to_entity, lines:purchase_order_lines(product_name, quantity, sku))'

/**
 * The one query. Every caller starts here, so "which orders can the factory
 * see" cannot drift between the list, the order page and the write gate.
 */
function sentOrders(admin: ReturnType<typeof createAdminClient>) {
  return admin
    .from('po_manufacturing')
    .select(SELECT)
    .not('sent_at', 'is', null)
    .eq('purchase_orders.leg', 'SRO_TO_SUPPLIER')
    .eq('purchase_orders.to_entity', 'SUPPLIER')
}

function shape(row: Row): FactoryOrder {
  return {
    po_id: row.po_id,
    po_number: row.purchase_orders?.po_number ?? null,
    sent_at: row.sent_at,
    confirmed_at: row.confirmed_at,
    est_start: row.est_start,
    est_finish: row.est_finish,
    finished_at: row.finished_at,
    short_materials: row.short_materials,
    lines: row.purchase_orders?.lines ?? [],
  }
}

/** Newest first: the one they were told about most recently is the one they want. */
export async function loadFactoryOrders(): Promise<FactoryOrder[]> {
  const { data, error } = await sentOrders(createAdminClient()).order('sent_at', { ascending: false })
  if (error) {
    console.error('loadFactoryOrders failed', error.message)
    return []
  }
  return ((data ?? []) as unknown as Row[]).map(shape)
}

/** Null for an order that does not exist, was never sent, or is not a manufacturing leg. */
export async function loadFactoryOrder(poId: string): Promise<FactoryOrder | null> {
  const { data, error } = await sentOrders(createAdminClient()).eq('po_id', poId).maybeSingle()
  if (error) {
    console.error('loadFactoryOrder failed', error.message)
    return null
  }
  return data ? shape(data as unknown as Row) : null
}

/**
 * The write gate. Same predicate as the list, so an order they cannot see is an
 * order they cannot act on, and a purchase order id typed into an action gets
 * the same answer as one typed into the address bar.
 */
export async function factoryOrderVisible(poId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('po_manufacturing')
    .select('po_id, purchase_orders!inner(id, leg, to_entity)')
    .not('sent_at', 'is', null)
    .eq('purchase_orders.leg', 'SRO_TO_SUPPLIER')
    .eq('purchase_orders.to_entity', 'SUPPLIER')
    .eq('po_id', poId)
    .maybeSingle()
  if (error) {
    console.error('factoryOrderVisible failed', error.message)
    return false
  }
  return Boolean(data)
}
