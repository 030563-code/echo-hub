import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { shipmentInScope } from '@/lib/cargo/scope.server'
import type { DepotProductOption, HubShipment, ShipmentLine } from './shipment'

/**
 * Reading the Hub's own shipment records. Service role, like the cargo tables: they revoke anon
 * and authenticated, so the scope is applied here and by the actions, never left to a policy.
 */

const SHIPMENT_COLUMNS =
  'id, spot_id, destination_depot, container_numbers, shipper, booked_on, collected_on, shipped_on, eta_port, eta_depot, delivered_on, notes, created_at, updated_at'

/**
 * 🔴 What is on a shipment and nothing else. The landed cost puts money on these same rows and
 * reads it with its own loader, behind cost.view, so somebody who only sees Transport is never
 * sent a price.
 */
export const LINE_COLUMNS = 'id, shipment_id, position, product_code, description, quantity, pallets, group_order_no, local_order_no'

/* eslint-disable @typescript-eslint/no-explicit-any */

function toLine(r: any): ShipmentLine {
  return {
    id: r.id,
    position: r.position,
    productCode: r.product_code,
    description: r.description ?? null,
    quantity: Number(r.quantity),
    pallets: r.pallets == null ? null : Number(r.pallets),
    groupOrderNo: r.group_order_no ?? null,
    localOrderNo: r.local_order_no ?? null,
  }
}

function toShipment(r: any, lines: ShipmentLine[]): HubShipment {
  return {
    id: r.id,
    spotId: r.spot_id ?? null,
    depot: r.destination_depot ?? null,
    containers: r.container_numbers ?? [],
    shipper: r.shipper ?? null,
    bookedOn: r.booked_on ?? null,
    collectedOn: r.collected_on ?? null,
    shippedOn: r.shipped_on ?? null,
    etaPort: r.eta_port ?? null,
    etaDepot: r.eta_depot ?? null,
    deliveredOn: r.delivered_on ?? null,
    notes: r.notes ?? null,
    lines,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

async function linesFor(shipmentIds: readonly string[]): Promise<Map<string, ShipmentLine[]>> {
  const by = new Map<string, ShipmentLine[]>()
  if (!shipmentIds.length) return by
  const { data } = await createAdminClient()
    .from('transport_shipment_line')
    .select(LINE_COLUMNS)
    .in('shipment_id', [...shipmentIds])
    .order('position')
  for (const r of (data ?? []) as any[]) by.set(r.shipment_id, [...(by.get(r.shipment_id) ?? []), toLine(r)])
  return by
}

async function loadOne(column: 'id' | 'spot_id', value: string): Promise<HubShipment | null> {
  const { data } = await createAdminClient().from('transport_shipment').select(SHIPMENT_COLUMNS).eq(column, value).maybeSingle()
  if (!data) return null
  const lines = await linesFor([(data as any).id])
  return toShipment(data, lines.get((data as any).id) ?? [])
}

export function loadHubShipment(id: string): Promise<HubShipment | null> {
  return loadOne('id', id)
}

export function loadHubShipmentBySpot(spotId: string): Promise<HubShipment | null> {
  return loadOne('spot_id', spotId)
}

/**
 * For the board: every shipment kept by hand in scope, and the contents of the booked ones.
 *
 * `depots` is the same scope the Cargo Partner board takes: the caller's depots, or null for the
 * two organisations every container passes through.
 */
export async function loadHubBoard(
  depots: readonly string[] | null,
  bookedSpotIds: readonly string[],
): Promise<{ hand: HubShipment[]; linesBySpot: Map<string, ShipmentLine[]> }> {
  const admin = createAdminClient()

  let query = admin.from('transport_shipment').select(SHIPMENT_COLUMNS).is('spot_id', null)
  if (depots) query = query.in('destination_depot', [...depots])
  const [{ data: handRows }, { data: bookedRows }] = await Promise.all([
    query.order('created_at', { ascending: false }),
    bookedSpotIds.length
      ? admin.from('transport_shipment').select('id, spot_id').in('spot_id', [...bookedSpotIds])
      : Promise.resolve({ data: [] as any[] }),
  ])

  const hand = (handRows ?? []) as any[]
  const booked = (bookedRows ?? []) as { id: string; spot_id: string }[]
  const lines = await linesFor([...hand.map((r) => r.id), ...booked.map((r) => r.id)])

  const linesBySpot = new Map<string, ShipmentLine[]>()
  for (const b of booked) linesBySpot.set(b.spot_id, lines.get(b.id) ?? [])
  return { hand: hand.map((r) => toShipment(r, lines.get(r.id) ?? [])), linesBySpot }
}

/**
 * Whether a Hub shipment is the caller's to see and change. A booked one follows the depot Cargo
 * Partner delivers to, like every other Transport action; one kept by hand follows the depot typed
 * on it. Null means "no such shipment", for both.
 */
export async function hubShipmentInScope(
  id: string,
  depots: readonly string[] | null,
): Promise<{ id: string; spotId: string | null; depot: string | null } | null> {
  const { data } = await createAdminClient()
    .from('transport_shipment')
    .select('id, spot_id, destination_depot')
    .eq('id', id)
    .maybeSingle()
  const row = data as { id: string; spot_id: string | null; destination_depot: string | null } | null
  if (!row) return null
  const found = { id: row.id, spotId: row.spot_id, depot: row.destination_depot }
  if (row.spot_id) return (await shipmentInScope(row.spot_id, depots)) ? found : null
  if (!depots) return found
  return row.destination_depot && depots.includes(row.destination_depot) ? found : null
}

/** The Hub record for a booked shipment, made the first time somebody writes on it. */
export async function ensureHubShipmentForSpot(spotId: string, uid: string): Promise<string | null> {
  const admin = createAdminClient()
  await admin
    .from('transport_shipment')
    .upsert({ spot_id: spotId, created_by: uid, updated_by: uid }, { onConflict: 'spot_id', ignoreDuplicates: true })
  const { data } = await admin.from('transport_shipment').select('id').eq('spot_id', spotId).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/**
 * What a depot can receive, for the product picker: its active items in Xero that belong to a
 * product family. The rest of the depot's items are expenses (Fuel, Hotel, Rent) that never sit
 * in a container.
 */
export async function depotProducts(depot: string | null): Promise<DepotProductOption[]> {
  if (!depot) return []
  const { data } = await createAdminClient()
    .from('product_depot_mapping')
    .select('xero_item_code, xero_item_description, product_family, is_active')
    .eq('depot_code', depot)
    .not('product_family', 'is', null)
  const byCode = new Map<string, DepotProductOption>()
  for (const r of (data ?? []) as any[]) {
    if (r.is_active === false) continue
    const code = String(r.xero_item_code ?? '').trim()
    const family = String(r.product_family ?? '').trim()
    // LTL-BAL-001 and its siblings are the charge for a part-truck delivery, not goods.
    if (!code || family === 'Shipping' || /^LTL-/i.test(code)) continue
    if (!byCode.has(code)) byCode.set(code, { code, description: String(r.xero_item_description ?? '').trim() || null, family })
  }
  return [...byCode.values()].sort((a, b) => (a.family ?? '').localeCompare(b.family ?? '') || a.code.localeCompare(b.code))
}
