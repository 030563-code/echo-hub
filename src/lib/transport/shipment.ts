import { z } from 'zod'
import { palletsFor } from '@/lib/pack-size'

/**
 * A shipment as the Hub keeps it: what is on it and, for one kept by hand, where it is.
 *
 * Dean, 24 Sep 2026: "Ideally all fields would need to be editable ... You must also be able to
 * edit shipments to be able to add what products are on the container." The fields are the rows
 * of Dave's "Shipments to ..." tabs: one column per barrier type, carrying its order numbers, its
 * barriers and its pallets, under the container's own dates.
 *
 * Pure, so the page, the actions and the tests agree.
 */

export const SHIPMENT_DEPOTS = ['US-BAL', 'US-SBD', 'CA-HAM', 'EU-SK', 'EU-FR', 'GB-BSE', 'AU-SYD'] as const
export type ShipmentDepot = (typeof SHIPMENT_DEPOTS)[number]

export function isShipmentDepot(value: unknown): value is ShipmentDepot {
  return typeof value === 'string' && (SHIPMENT_DEPOTS as readonly string[]).includes(value)
}

/** A line of what is on a shipment. Money is not here: that is the landed cost's, behind cost.view. */
export interface ShipmentLine {
  id: string
  position: number
  productCode: string
  description: string | null
  quantity: number
  pallets: number | null
  groupOrderNo: string | null
  localOrderNo: string | null
}

/** The Hub's own record of a shipment. */
export interface HubShipment {
  id: string
  /** Null until Cargo Partner has booked it. */
  spotId: string | null
  /** Typed for a shipment kept by hand; a booked one follows Cargo Partner. */
  depot: string | null
  containers: string[]
  shipper: string | null
  bookedOn: string | null
  collectedOn: string | null
  shippedOn: string | null
  etaPort: string | null
  etaDepot: string | null
  deliveredOn: string | null
  notes: string | null
  lines: ShipmentLine[]
  createdAt: string
  updatedAt: string
}

/** A product a depot can receive, for the picker. */
export interface DepotProductOption {
  code: string
  description: string | null
  family: string | null
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * A container number as ISO 6346 writes it: four letters and seven digits. Dave's sheet sometimes
 * carries a space ("ABCU 1234567"), which is dropped. Null for anything else.
 */
export function containerNumber(typed: string): string | null {
  const value = typed.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z]{4}\d{7}$/.test(value) ? value : null
}

/** Container numbers typed in one box, split on commas, semicolons or new lines. */
export function containerList(text: string): { ok: true; numbers: string[] } | { ok: false; bad: string } {
  const numbers: string[] = []
  for (const part of text.split(/[,;\n]+/)) {
    const raw = part.trim()
    if (!raw) continue
    const number = containerNumber(raw)
    if (!number) return { ok: false, bad: raw }
    if (!numbers.includes(number)) numbers.push(number)
  }
  return { ok: true, numbers }
}

// ---------------------------------------------------------------------------
// What the page sends
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'not a date')
const optionalDate = isoDate.nullish().transform((v) => v ?? null)
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = (v ?? '').trim()
      return t ? t : null
    })

export const shipmentLineSchema = z.object({
  id: z.string().uuid().nullish().transform((v) => v ?? null),
  productCode: z.string().trim().min(1, 'Every line needs a product.').max(40),
  description: optionalText(200),
  quantity: z.number().finite().positive('A quantity is more than nothing.').max(1_000_000),
  pallets: z.number().finite().min(0).max(1000).nullish().transform((v) => v ?? null),
  groupOrderNo: optionalText(40),
  localOrderNo: optionalText(40),
})
export type ShipmentLineInput = z.infer<typeof shipmentLineSchema>

export const shipmentLinesSchema = z
  .array(shipmentLineSchema)
  .max(40, 'Forty lines is the most one shipment takes.')
  .refine((lines) => {
    const ids = lines.map((l) => l.id).filter(Boolean)
    return new Set(ids).size === ids.length
  }, 'A line was sent twice.')

export const handShipmentDetailsSchema = z.object({
  depot: z.enum(SHIPMENT_DEPOTS),
  containers: z.string().max(200).default(''),
  shipper: optionalText(80),
  bookedOn: optionalDate,
  collectedOn: optionalDate,
  shippedOn: optionalDate,
  etaPort: optionalDate,
  etaDepot: optionalDate,
  deliveredOn: optionalDate,
  notes: optionalText(2000),
})
export type HandShipmentDetails = z.infer<typeof handShipmentDetailsSchema>

/** The database row for a list of lines, positions taken from the order they came in. */
export function lineRows(lines: readonly ShipmentLineInput[]) {
  return lines.map((l, position) => ({
    id: l.id ?? '',
    position,
    product_code: l.productCode,
    description: l.description ?? '',
    quantity: l.quantity,
    pallets: l.pallets == null ? '' : l.pallets,
    group_order_no: l.groupOrderNo ?? '',
    local_order_no: l.localOrderNo ?? '',
  }))
}

// ---------------------------------------------------------------------------
// Pallets
// ---------------------------------------------------------------------------

/** The families whose pack size is known (pack-size.ts), mapped to the model the table is keyed on. */
const FAMILY_MODEL: Record<string, string> = {
  H8: 'H8',
  H9: 'H9',
  H9X: 'H9X 2.1W',
  H10: 'H10',
}

/**
 * The pallets a quantity of barriers makes: 70 a pallet, 30 for H8, rounded up, as the factory packs
 * them. Null for anything else (cutting stations, fitting kits), which somebody types, because five
 * cutting stations went on two pallets and no table says so.
 */
export function suggestedPallets(family: string | null | undefined, quantity: number): number | null {
  const model = FAMILY_MODEL[String(family ?? '').trim().toUpperCase()]
  if (!model || !(quantity > 0)) return null
  return palletsFor(model, quantity)
}

// ---------------------------------------------------------------------------
// Dave's sheet
// ---------------------------------------------------------------------------

export interface SheetRow {
  barrierType: string | null
  quantity: number | null
  orderNo: string | null
  orderNoLocal: string | null
}

/** The suffix each depot's Xero item codes carry: H9BALT, H9SB, H9HAM. */
const DEPOT_SUFFIX: Record<string, string> = { 'US-BAL': 'BALT', 'US-SBD': 'SB', 'CA-HAM': 'HAM' }

/**
 * The item code for what the sheet calls a barrier type. The sheet mixes codes ("H10HERCB",
 * "H9BALT") with plain types ("H9"), so a type that is not a code is matched to the depot's own
 * item for it (H9 at Baltimore is H9BALT) and otherwise kept as typed.
 */
export function productCodeFor(barrierType: string, depot: string | null, products: readonly DepotProductOption[]): string {
  const typed = barrierType.trim()
  const upper = typed.toUpperCase()
  const exact = products.find((p) => p.code.toUpperCase() === upper)
  if (exact) return exact.code
  const suffix = depot ? DEPOT_SUFFIX[depot] : undefined
  if (suffix) {
    const conventional = products.find((p) => p.code.toUpperCase() === `${upper}${suffix}`)
    if (conventional) return conventional.code
  }
  const byFamily = products.filter((p) => (p.family ?? '').toUpperCase() === upper)
  return byFamily.length === 1 ? byFamily[0].code : typed
}

/** Lines to start from, one per barrier type the sheet lists for this shipment. */
export function linesFromSheet(
  rows: readonly SheetRow[],
  depot: string | null,
  products: readonly DepotProductOption[],
): ShipmentLineInput[] {
  const out: ShipmentLineInput[] = []
  for (const row of rows) {
    const type = (row.barrierType ?? '').trim()
    if (!type || !(Number(row.quantity) > 0)) continue
    const code = productCodeFor(type, depot, products)
    const product = products.find((p) => p.code === code)
    out.push({
      id: null,
      productCode: code,
      description: product?.description ?? null,
      quantity: Number(row.quantity),
      pallets: suggestedPallets(product?.family ?? null, Number(row.quantity)),
      groupOrderNo: row.orderNo?.trim() || null,
      localOrderNo: row.orderNoLocal?.trim() || null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Where a shipment kept by hand is
// ---------------------------------------------------------------------------

export interface HandProgress {
  /** Said once, in words, the way the booked shipments say it. */
  status: string
  on: string | null
  isComplete: boolean
  /** The date it is due at the depot, else at the port. */
  eta: string | null
}

export function handProgress(
  s: Pick<HubShipment, 'collectedOn' | 'shippedOn' | 'etaPort' | 'etaDepot' | 'deliveredOn'>,
): HandProgress {
  const eta = s.etaDepot ?? s.etaPort
  if (s.deliveredOn) return { status: 'Delivered', on: s.deliveredOn, isComplete: true, eta: s.deliveredOn }
  if (s.shippedOn) return { status: 'Shipped', on: s.shippedOn, isComplete: false, eta }
  if (s.collectedOn) return { status: 'Collected from the factory', on: s.collectedOn, isComplete: false, eta }
  return { status: 'Not shipped yet', on: null, isComplete: false, eta }
}

/** What Dave's tabs call the depot's own order number: "Order No USA / Canada". */
export function localOrderLabel(depot: string | null): string {
  return depot?.startsWith('US-') || depot?.startsWith('CA-') ? 'USA / Canada order' : 'Depot order'
}

// ---------------------------------------------------------------------------
// One line on the board
// ---------------------------------------------------------------------------

const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))

/** "560 × H10HERCB, 5 × CS1BALT on 10 pallets", or null when nothing is listed. */
export function contentsSummary(lines: readonly Pick<ShipmentLine, 'productCode' | 'quantity' | 'pallets'>[]): string | null {
  if (!lines.length) return null
  const goods = lines.map((l) => `${count(l.quantity)} × ${l.productCode}`).join(', ')
  const known = lines.filter((l) => l.pallets != null)
  if (known.length !== lines.length) return goods
  const pallets = known.reduce((sum, l) => sum + (l.pallets ?? 0), 0)
  return `${goods} on ${count(pallets)} ${pallets === 1 ? 'pallet' : 'pallets'}`
}

/** The order numbers a shipment travels under, each once, for the board's search and meta line. */
export function lineReferences(lines: readonly Pick<ShipmentLine, 'groupOrderNo' | 'localOrderNo'>[]): string[] {
  const out: string[] = []
  for (const l of lines) for (const r of [l.groupOrderNo, l.localOrderNo]) if (r && !out.includes(r)) out.push(r)
  return out
}
