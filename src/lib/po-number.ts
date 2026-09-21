import type { PurchaseOrder } from './erp-types'
import { RAISING_PARTIES } from './po-raising'

// The purchase order numbering scheme (Dean, 14 Sep 2026). The Hub mints every
// number in the database trigger (po_before_insert -> hub_mint_po_number, see
// supabase/migrations/20260914140000_po_numbering_scheme.sql) and n8n sends that
// exact number to Xero:
//
//   EBUSA8001 / EBCAN8001 / EBFRA8001 / EBAUS8001   the depot's order on Group
//   EBGRP8001                                        Group's order on s.r.o.
//   EBSRO8001-1                                      manufacturing order to Bamida
//   EBSRO8001-2                                      shipping order to Cargo Partner
//   EBSRO8001-3                                      accounting order to Bamida
//
// s.r.o.'s orders carry the digits of their Group order, and the suffix is the
// document's purpose. The new numbers say where they sit in the chain, so they
// are shown as they are. Chains raised before the scheme keep the older label,
// built from master_ref: PO-001 (the order) / PO-001-1 (Bamida) / PO-001-2 (Cargo).
const LEG_INDEX: Record<PurchaseOrder['leg'], number> = {
  DEPOT_TO_EB_GROUP: 0,
  EB_GROUP_TO_SRO: 0,
  SRO_TO_SUPPLIER: 1,
  SRO_TO_CARGO: 2,
}

/**
 * The depot code to its number series. Mirrors public.hub_po_prefix_for_depot;
 * tests/unit/po-numbering-schema-coherence.test.ts keeps the two identical.
 *
 * DERIVED from RAISING_PARTIES rather than written out again, because it was
 * one of four copies of the same facts and the copies had drifted: this one
 * carried EU-FR and AU-SYD while the create page offered three depots and n8n
 * silently treated anything but CA-HAM and US-SBD as US Baltimore. The depot
 * leg only: Group and s.r.o. raise their own legs and take their numbers from
 * those, not from a depot series.
 */
export const PO_PREFIX_BY_DEPOT: Readonly<Record<string, string>> = Object.fromEntries(
  RAISING_PARTIES.filter((p) => p.leg === 'DEPOT_TO_EB_GROUP').map((p) => [p.code, p.series]),
)

/** True when a depot can raise an order, i.e. it has a number series. */
export function depotHasPoSeries(depot: string): boolean {
  return Object.hasOwn(PO_PREFIX_BY_DEPOT, depot)
}

/**
 * The number series for a depot. Throws for a depot with no series, the same
 * refusal the database makes, rather than borrowing another country's prefix.
 */
export function poPrefixForDepot(depot: string): string {
  if (!depotHasPoSeries(depot)) {
    throw new Error(
      `Depot ${depot || '(blank)'} has no purchase order number series. Depot orders can be raised for ${Object.keys(PO_PREFIX_BY_DEPOT).join(', ')}.`,
    )
  }
  return PO_PREFIX_BY_DEPOT[depot]
}

// EBUK joined the scheme with pending/20260921140000_po_raising_parties.sql.
// This pattern and public.po_guard_number_update's must stay identical; the two
// coherence tests pin them sample by sample.
const NEW_SCHEME = /^(?:EB(?:USA|CAN|FRA|UK|AUS|GRP)\d+|EBSRO\d+-[123])$/
const SRO_SUFFIX = /^EBSRO\d+-([123])$/
const SRO_SUFFIX_TAIL = /-[123]$/
const GROUP_NUMBER = /^EBGRP(\d+)$/

export type PoNumberPurpose = 'Manufacturing' | 'Shipping' | 'Accounting'

const PURPOSE_SUFFIX: Record<PoNumberPurpose, 1 | 2 | 3> = {
  Manufacturing: 1,
  Shipping: 2,
  Accounting: 3,
}

/** A number minted under the 14 Sep 2026 scheme (EBUSA8001, EBGRP8001, EBSRO8001-2). */
export function isNewSchemePoNumber(poNumber: string | null | undefined): boolean {
  return !!poNumber && NEW_SCHEME.test(poNumber.trim())
}

/**
 * What an s.r.o. document is for, read off its suffix: -1 Manufacturing (to
 * Bamida, specs), -2 Shipping (to Cargo Partner), -3 Accounting (to Bamida,
 * priced). Null for every other number, which has no suffix to read.
 */
export function poNumberPurpose(poNumber: string | null | undefined): PoNumberPurpose | null {
  const m = poNumber?.trim().match(SRO_SUFFIX)
  if (!m) return null
  return m[1] === '1' ? 'Manufacturing' : m[1] === '2' ? 'Shipping' : 'Accounting'
}

/**
 * The ORDER's number, with any document suffix taken off: EBSRO8001-1 is a
 * document of order EBSRO8001.
 *
 * Dean, 17 Sep 2026: "the SRO PO on the kanban board appears as EBSR8XXX
 * whatever the number is ... Then when you click on that PO it is split up into
 * manufacturing PO, priced PO, Shipping PO." One order on the board; the
 * suffixes belong to the three documents inside it, and each document still
 * prints its own number on its own face.
 *
 * Anything that is not an s.r.o. document number passes straight through.
 */
export function poOrderNumber(poNumber: string | null | undefined): string {
  const value = String(poNumber ?? '').trim()
  return SRO_SUFFIX.test(value) ? value.replace(SRO_SUFFIX_TAIL, '') : value
}

/**
 * Another document of the SAME s.r.o. order: EBSRO8001-1 asked for Shipping is
 * EBSRO8001-2. Null for a number that is not an s.r.o. one, so a chain raised
 * before the scheme keeps whatever it carries.
 */
export function poDocumentNumber(
  poNumber: string | null | undefined,
  purpose: PoNumberPurpose,
): string | null {
  const base = poOrderNumber(poNumber)
  return /^EBSRO\d+$/.test(base) ? `${base}-${PURPOSE_SUFFIX[purpose]}` : null
}

/**
 * The s.r.o. document number that belongs under a Group order: EBGRP8001 with
 * Shipping is EBSRO8001-2. The same derivation the database mint makes. Null
 * when the Group order predates the scheme, so the caller keeps its old label.
 */
export function sroDocumentNumber(
  groupPoNumber: string | null | undefined,
  purpose: PoNumberPurpose,
): string | null {
  const m = groupPoNumber?.trim().match(GROUP_NUMBER)
  return m ? `EBSRO${m[1]}-${PURPOSE_SUFFIX[purpose]}` : null
}

/**
 * The chain label for an order. A number from the new scheme already says
 * where it sits (EBSRO8001-1 is the manufacturing order under EBGRP8001), so it
 * is returned as it is.
 *
 * An older chain keeps its "PO-001 / PO-001-1 / PO-001-2" label, derived from
 * the shared master_ref and the leg's role: the SRO order reads as the base,
 * its Bamida child as base-1, its Cargo child as base-2. The "MR-" prefix is
 * stripped. Display only: the canonical number stays po_number, which is what
 * n8n, Xero and Cargo Partner look up.
 */
export function chainNumber(po: Pick<PurchaseOrder, 'po_number' | 'master_ref' | 'leg'>): string {
  if (isNewSchemePoNumber(po.po_number)) return po.po_number
  // No master_ref = no real chain to express, so show the canonical number as-is.
  if (!po.master_ref) return po.po_number
  const base = po.master_ref.replace(/^MR-/, '')
  const idx = LEG_INDEX[po.leg] ?? 0
  return idx === 0 ? base : `${base}-${idx}`
}

/**
 * A Hub-minted number (`PO-01105`) vs a real Xero number written back by n8n
 * (`EBG26086`, `EBUSA26013`, `EBSRO…`). Kept as a predicate because the two are
 * still worth telling apart; it no longer decides what the screen shows.
 */
export function isPlaceholderPoNumber(poNumber: string | null | undefined): boolean {
  return !poNumber || /^PO-\d+$/i.test(poNumber.trim())
}

export const AWAITING_XERO_PO = 'Awaiting Xero PO number'

/**
 * What to SHOW for a PO number.
 *
 * This used to hide a Hub-minted number behind "Awaiting Xero PO number", on the
 * reasoning that the Xero number is the real one. With the Xero hand-off switched
 * off for the feedback round that label is simply wrong: no number is coming, and
 * an order with no visible number cannot be discussed, searched for or matched to
 * a shipment. So the Hub number is shown, and the Xero number replaces it in the
 * same field once n8n writes it back. Only a genuinely absent number falls back to
 * the label.
 */
export function displayPoNumber(poNumber: string | null | undefined): string {
  return poNumber?.trim() ? poNumber : AWAITING_XERO_PO
}

/** Human label for a leg — shared so the board, table and kanban never disagree. */
export function legLabel(leg: string): string {
  if (leg === 'DEPOT_TO_EB_GROUP') return 'Depot → Group'
  if (leg === 'EB_GROUP_TO_SRO') return 'Group → SRO'
  if (leg === 'SRO_TO_SUPPLIER') return 'SRO → Bamida'
  if (leg === 'SRO_TO_CARGO') return 'SRO → Cargo'
  return leg
}

/** True if every line of a PO has been fully received (Σ receipts ≥ ordered qty). */
export function isFullyReceived(lines: { quantity: number; qty_received?: number }[]): boolean {
  if (!lines.length) return false
  return lines.every((l) => (l.qty_received ?? 0) >= l.quantity)
}
