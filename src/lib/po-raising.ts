/**
 * Who can raise a purchase order, what they raise, and in whose Xero.
 *
 * ONE table for the parties, and ONE source for what each may order:
 * public.product_depot_mapping, one row per (party, SKU) with the HubSpot SKU
 * that region uses, the Xero organisation and the Xero item code. Dean,
 * 22 Sep 2026: "when I go to France it still shows the US/NA hubspot_sku_codes;
 * remember we have the region specific codes in product_depot_mapping in
 * supabase already for each depot."
 *
 * Until then the raise page listed po_product_catalog, sixteen North American
 * SKUs, and looked their Xero codes up in product_code_master's per-country
 * columns, so a French order carried EBH9NA where France's own SKU is EBH9 and
 * its stock rows (written from the same mapping by the Xero sync) are keyed
 * EBH9 too. The mapping also knows things the columns cannot: San Bernardino's
 * ex-rental H9 has its own code, and Group and s.r.o. have rows of their own.
 *
 * 🔴 NEVER DEFAULT. Before 21 Sep 2026 n8n's code column defaulted to Baltimore
 * and its tenant to the USA, so a French order would have been created in the
 * United States Xero organisation with Baltimore codes and nothing said. An
 * unmapped party refuses; a product with no row for the party is not offered
 * and is refused on the way in.
 *
 * EB-GROUP and EB-SRO are not depots and do not raise the depot leg: Group buys
 * from s.r.o. with no depot above it, s.r.o. buys from the manufacturer.
 *
 * Pure: no database and no server-only import, so the form, the server actions
 * and the tests all read the same table.
 */

import type { PurchaseOrder } from '@/lib/erp-types'
import { type OrgCode } from '@/lib/organisations'

export interface RaisingParty {
  /** from_entity on the order: a depot code, or an entity code for Group and s.r.o. */
  code: string
  /** What the dropdown says. */
  label: string
  /** The leg this party's order IS. Not always the depot leg. */
  leg: PurchaseOrder['leg']
  /** Who the order is placed on. */
  to: string
  /** The organisation that must be held to raise it, and whose Xero receives it. */
  org: OrgCode
  /** The purchase order number series. Mirrors public.hub_po_prefix_for_depot. */
  series: string
  /**
   * Why this party is not live YET, or null when it is. A fact about what has
   * been deployed, not about the data: clear it in the SAME sitting as the
   * change it names. All were cleared on 21 Sep 2026.
   */
  pending: string | null
}

/**
 * The registry, in the order the dropdown shows them: depots first, then the
 * two companies that buy on their own account.
 *
 * `series` must stay identical to public.hub_po_prefix_for_depot for the depot
 * leg; tests/unit/po-numbering-schema-coherence.test.ts pins that.
 */
export const RAISING_PARTIES: readonly RaisingParty[] = [
  { code: 'US-BAL', label: 'US Baltimore', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-USA', series: 'EBUSA', pending: null },
  { code: 'US-SBD', label: 'US San Bernardino', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-USA', series: 'EBUSA', pending: null },
  { code: 'CA-HAM', label: 'Canada Hamilton', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-CANADA', series: 'EBCAN', pending: null },
  { code: 'EU-FR', label: 'France', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-FRANCE', series: 'EBFRA', pending: null },
  { code: 'GB-BSE', label: 'UK Bury St Edmunds', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-UK', series: 'EBUK', pending: null },
  // Has a number series and a Xero organisation. What it may order is whatever
  // product_depot_mapping holds for AU-SYD, which on 22 Sep 2026 is nothing:
  // the form says so, and nothing is guessed for it.
  { code: 'AU-SYD', label: 'Australia Sydney', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-AUSTRALIA', series: 'EBAUS', pending: null },
  { code: 'EB-GROUP', label: 'Group (buying from s.r.o.)', leg: 'EB_GROUP_TO_SRO', to: 'EB-SRO', org: 'EB-GROUP', series: 'EBGRP', pending: null },
  { code: 'EB-SRO', label: 's.r.o. (buying from the manufacturer)', leg: 'SRO_TO_SUPPLIER', to: 'SUPPLIER', org: 'EB-SRO', series: 'EBSRO', pending: null },
]

const BY_CODE = new Map(RAISING_PARTIES.map((p) => [p.code, p]))

/** The party, or null for a code nobody has mapped. Never a default. */
export function raisingParty(code: string | null | undefined): RaisingParty | null {
  return BY_CODE.get(String(code ?? '').trim().toUpperCase()) ?? null
}

/**
 * Why this party cannot raise an order, or null when it can.
 *
 * A sentence rather than a boolean, because every caller shows it: the form
 * greys the option, the server action refuses with it, and a test reads it.
 */
export function raisingBlockedReason(code: string | null | undefined): string | null {
  const party = raisingParty(code)
  if (!party) {
    return `${String(code ?? '').trim() || '(blank)'} cannot raise purchase orders. Those that can: ${RAISING_PARTIES.map((p) => p.code).join(', ')}.`
  }
  if (party.pending) {
    return `${party.label} is not live yet. ${party.pending}`
  }
  return null
}

export function canRaiseFor(code: string | null | undefined): boolean {
  return raisingBlockedReason(code) === null
}

/** The parties that can raise today, for the dropdown. */
export const RAISABLE_PARTIES: readonly RaisingParty[] = RAISING_PARTIES.filter((p) => canRaiseFor(p.code))

// ---------------------------------------------------------------------------
// What a party may order: public.product_depot_mapping
// ---------------------------------------------------------------------------

/** One row of product_depot_mapping, as the pages select it. */
export interface DepotProduct {
  /** The raising party: a depot code, EB-GROUP or EB-SRO. */
  depot_code: string
  /** The SKU that region uses, where it has one. Null since 22 Sep 2026: a Xero
   *  item can exist with no HubSpot SKU at all (shipping lines, ex-rental
   *  stock), and the Xero item code is the identity now. */
  hubspot_sku_code: string | null
  /** The ItemCode in that party's Xero organisation. */
  xero_item_code: string | null
  xero_item_description: string | null
  product_family: string | null
  is_active?: boolean | null
}

/** The columns every reader selects, so a new one cannot be left unfetched. */
export const DEPOT_MAPPING_COLUMNS =
  'depot_code, hubspot_sku_code, xero_item_code, xero_item_description, product_family, is_active'

/** A product this party may put on an order, with the code Xero will receive. */
export interface OrderableProduct {
  /** What the order line carries. The HubSpot SKU where there is one, otherwise
   *  the Xero item code, which is the only identifier such a product has. */
  sku: string
  product_name: string
  product_family: string | null
  xeroItemCode: string
  /** Null when nobody has given this product a HubSpot SKU. */
  hubspotSku: string | null
}

const clean = (v: string | null | undefined) => (v ?? '').trim()

/**
 * The products this party may order: its own active rows of the mapping that
 * carry a Xero item code, one per SKU, in family then SKU order.
 *
 * Dean, 21 Sep 2026: "The line items have to be loaded depot specific." A row
 * without a code is not offered, because the order would reach Xero without
 * that line: n8n drops an unmapped line into `unmapped_skus` and carries on.
 * Codes are trimmed because at least one live value carried trailing spaces,
 * and a Xero ItemCode with a trailing space does not match the item.
 */
export function catalogueFor(party: RaisingParty, mapping: readonly DepotProduct[]): OrderableProduct[] {
  const byCode = new Map<string, OrderableProduct>()
  for (const row of mapping) {
    if (clean(row.depot_code).toUpperCase() !== party.code) continue
    if (row.is_active === false) continue
    const code = clean(row.xero_item_code)
    // 🔴 Only the Xero code is required. A HubSpot SKU is optional since Dean
    // asked on 22 Sep 2026 for every Xero item to be orderable "even if they
    // dont have a hubspot sku code"; a row with no Xero code is still refused,
    // because the order would reach Xero without that line.
    if (!code) continue
    const sku = clean(row.hubspot_sku_code)
    // Keyed on the Xero code, which is now the identity. Two HubSpot SKUs can
    // point at one Xero item (EBH10HERC and EBH10HERCNA both mean H10HERCB) and
    // offering the same item twice is offering a choice that is not one.
    byCode.set(code, {
      sku: sku || code,
      product_name: clean(row.xero_item_description) || sku || code,
      product_family: clean(row.product_family) || null,
      xeroItemCode: code,
      hubspotSku: sku || null,
    })
  }
  return [...byCode.values()].sort(
    (a, b) =>
      (a.product_family ?? '').localeCompare(b.product_family ?? '') ||
      a.xeroItemCode.localeCompare(b.xeroItemCode),
  )
}

/** This party's Xero item code for a SKU, or null when the mapping has none. */
export function xeroItemCodeFor(party: RaisingParty, sku: string, mapping: readonly DepotProduct[]): string | null {
  const wanted = clean(sku)
  return catalogueFor(party, mapping).find((p) => p.sku === wanted)?.xeroItemCode ?? null
}
