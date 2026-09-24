import 'server-only'

import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { packageFrom } from '@/lib/customs/view'
import type { CustomsPackage } from '@/lib/customs/nippon-invoice'
import { ensureHubShipmentForSpot } from './shipments.server'
import { landedCostAllowed, landedCurrency } from './cost-access'
import {
  LOCAL_KEYS,
  costsFromBills,
  effectiveLocalCosts,
  landedCost,
  type CostInvoice,
  type CostLine,
  type LandedResult,
  type LocalKey,
  type LocalSource,
} from './landed-cost'
import type { ShipmentLine } from './shipment'

/**
 * Reading and writing the landed cost. Service role behind the Hub's own checks, like every
 * Transport table; the money is read here and nowhere else.
 */

export interface LandedInvoice extends CostInvoice {
  invoiceDate: string | null
  supplier: string | null
  otherLabel: string | null
}

export interface LineMoney {
  lineId: string
  invoiceId: string | null
  goodsAmount: number | null
}

export interface TypedLocal {
  values: Partial<Record<LocalKey, number | null>>
  otherLabel: string | null
  journalDate: string | null
  notes: string | null
}

export interface LandedView {
  currency: string
  invoices: LandedInvoice[]
  money: LineMoney[]
  typed: TypedLocal
  /** Nippon's bills for this shipment that were read, newest first. */
  bills: { id: string; invoiceNumber: string | null }[]
  source: Record<LocalKey, LocalSource>
  /** What the bills say, for showing beside what was typed. */
  billTotals: Partial<Record<LocalKey, number>>
  billNotes: string[]
  result: LandedResult
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown) => (v == null ? null : Number(v))

/** Nippon's bills for a shipment: by its SPOT ID, and by container for one kept by hand. */
async function billsFor(spotId: string | null, containers: readonly string[]) {
  const admin = createAdminClient()
  const found = new Map<string, { id: string; invoiceNumber: string | null; date: string | null; pkg: CustomsPackage }>()
  const take = (rows: any[]) => {
    for (const r of rows) {
      if (r.duplicate_of || r.ocr_status !== 'done') continue
      const pkg = packageFrom(r.extraction)
      if (!pkg || pkg.is_invoice === false) continue
      found.set(r.id, { id: r.id, invoiceNumber: r.invoice_number ?? null, date: r.invoice_date ?? null, pkg })
    }
  }
  const columns = 'id, invoice_number, invoice_date, ocr_status, duplicate_of, extraction'
  if (spotId) {
    const { data } = await admin.from('customs_bills').select(columns).eq('spot_id', spotId)
    take((data ?? []) as any[])
  }
  for (const container of containers) {
    // The waybill's container numbers, as Claude read them.
    const { data } = await admin
      .from('customs_bills')
      .select(columns)
      .contains('extraction', { waybill: { container_numbers: [container] } })
    take((data ?? []) as any[])
  }
  return [...found.values()].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
}

export async function loadLandedCost(shipment: {
  hubId: string | null
  spotId: string | null
  depot: string | null
  containers: readonly string[]
  lines: readonly ShipmentLine[]
}): Promise<LandedView> {
  const admin = createAdminClient()
  const currency = landedCurrency(shipment.depot)

  const [invoiceRows, moneyRows, costRow, bills] = await Promise.all([
    shipment.hubId
      ? admin.from('transport_shipment_invoice').select('*').eq('shipment_id', shipment.hubId).order('created_at')
      : Promise.resolve({ data: [] as any[] }),
    shipment.hubId
      ? admin.from('transport_shipment_line').select('id, invoice_id, goods_amount').eq('shipment_id', shipment.hubId)
      : Promise.resolve({ data: [] as any[] }),
    shipment.hubId
      ? admin.from('transport_shipment_cost').select('*').eq('shipment_id', shipment.hubId).maybeSingle()
      : Promise.resolve({ data: null }),
    billsFor(shipment.spotId, shipment.containers),
  ])

  const invoices: LandedInvoice[] = ((invoiceRows.data ?? []) as any[]).map((r) => ({
    id: r.id,
    number: r.invoice_number,
    invoiceDate: r.invoice_date ?? null,
    supplier: r.supplier ?? null,
    currency: r.currency,
    rate: num(r.fx_rate),
    palletising: Number(r.palletising ?? 0),
    delivery: Number(r.delivery ?? 0),
    insurance: Number(r.insurance ?? 0),
    otherAmount: Number(r.other_amount ?? 0),
    otherLabel: r.other_label ?? null,
  }))
  const money: LineMoney[] = ((moneyRows.data ?? []) as any[]).map((r) => ({
    lineId: r.id,
    invoiceId: r.invoice_id ?? null,
    goodsAmount: num(r.goods_amount),
  }))
  const c = (costRow.data ?? null) as any
  const typed: TypedLocal = {
    values: {
      duty: num(c?.duty),
      mpf: num(c?.mpf),
      hmf: num(c?.hmf),
      disbursement: num(c?.disbursement),
      clearance: num(c?.clearance),
      containerDelivery: num(c?.container_delivery),
      other: num(c?.other_amount),
    },
    otherLabel: c?.other_label ?? null,
    journalDate: c?.journal_date ?? null,
    notes: c?.notes ?? null,
  }

  const fromBills = costsFromBills(bills.map((b) => b.pkg))
  const { local, source } = effectiveLocalCosts(typed.values, fromBills)
  const moneyBy = new Map(money.map((m) => [m.lineId, m]))
  const lines: CostLine[] = shipment.lines.map((l) => ({
    id: l.id,
    productCode: l.productCode,
    quantity: l.quantity,
    pallets: l.pallets,
    invoiceId: moneyBy.get(l.id)?.invoiceId ?? null,
    goodsAmount: moneyBy.get(l.id)?.goodsAmount ?? null,
  }))

  const billTotals: Partial<Record<LocalKey, number>> = {}
  for (const key of LOCAL_KEYS) {
    const total = fromBills?.local[key]?.total
    if (total != null) billTotals[key] = total
  }

  return {
    currency,
    invoices,
    money,
    typed,
    bills: bills.map((b) => ({ id: b.id, invoiceNumber: b.invoiceNumber })),
    source,
    billTotals,
    billNotes: fromBills?.notes ?? [],
    result: landedCost({ currency, lines, invoices, local }),
  }
}

/**
 * The shipment an action on the landed cost may write to, after the checks: transport.view and
 * cost.view, and the shipment's own organisation or Group. A booked shipment gets its Hub record
 * the first time. "No such shipment" for anything the caller may not see, so a SPOT ID outside
 * their books is not confirmed to exist.
 */
export async function landedCostTarget(
  target: { spotId: string } | { id: string },
): Promise<{ ok: true; uid: string; shipmentId: string; key: string; depot: string | null } | { ok: false; error: string }> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('transport.view') || !auth.capabilities.has('cost.view')) {
    return { ok: false, error: 'Only somebody who sees costs can change the landed cost.' }
  }
  const admin = createAdminClient()
  const who = { capabilities: auth.capabilities, organisations: auth.profile.organisations }

  if ('spotId' in target) {
    const { data } = await admin.from('cargo_shipment').select('destination_depot').eq('spot_id', target.spotId).maybeSingle()
    const depot = (data as { destination_depot: string | null } | null)?.destination_depot ?? null
    if (!data || !landedCostAllowed(who, depot)) return { ok: false, error: 'No such shipment.' }
    const shipmentId = await ensureHubShipmentForSpot(target.spotId, auth.user.id)
    if (!shipmentId) return { ok: false, error: 'The shipment could not be opened for costing.' }
    return { ok: true, uid: auth.user.id, shipmentId, key: target.spotId, depot }
  }

  const { data } = await admin.from('transport_shipment').select('id, spot_id, destination_depot').eq('id', target.id).maybeSingle()
  const row = data as { id: string; spot_id: string | null; destination_depot: string | null } | null
  if (!row) return { ok: false, error: 'No such shipment.' }
  let depot = row.destination_depot
  if (row.spot_id) {
    const { data: cargo } = await admin.from('cargo_shipment').select('destination_depot').eq('spot_id', row.spot_id).maybeSingle()
    depot = (cargo as { destination_depot: string | null } | null)?.destination_depot ?? null
  }
  if (!landedCostAllowed(who, depot)) return { ok: false, error: 'No such shipment.' }
  return { ok: true, uid: auth.user.id, shipmentId: row.id, key: row.spot_id ?? row.id, depot }
}
