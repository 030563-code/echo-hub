/**
 * Who can raise a purchase order, what they raise, and in whose Xero.
 *
 * ONE table. Before this the same facts were written out four times and none of
 * them agreed:
 *
 *   1. V1_DEPOTS in purchase-orders/create/page.tsx  ["US-BAL","US-SBD","CA-HAM"]
 *   2. DEPOT_CODE_COL in raise-po-form.tsx           the same three
 *   3. PO_PREFIX_BY_DEPOT in po-number.ts            five, including EU-FR and AU-SYD
 *   4. "Depot: Build LineItems" in n8n Fz7xXgifva5n548u, which is the one that
 *      decides what Xero actually receives
 *
 * 🔴 THE FOURTH ONE DEFAULTED. Its code was `let codeCol = "code_usa_balt"`
 * followed by three `if`s, and its Xero tenant was
 * `from_entity === "CA-HAM" ? Canada : USA`. EU-FR already had a number series,
 * so the first French order raised would have been created in the UNITED STATES
 * Xero organisation carrying US Baltimore item codes, and nothing anywhere would
 * have said a word. A default is the wrong shape for this: an unmapped party
 * must refuse, the way poPrefixForDepot already refuses a depot with no series.
 *
 * Dean, 21 Sep 2026: "add this raising depots in the purchase orders, EU-FR,
 * GB-BSE, EB-GROUP, EB-SRO ... the line items have to be loaded depot specific
 * ... ensure the correct purchase orders are raised in the correct Xero
 * organisations mapped to the correct xero_item_codes".
 *
 * EB-GROUP and EB-SRO are not depots and they do not raise the depot leg. Group
 * raising means Group buys from s.r.o. with no depot above it, and s.r.o.
 * raising means s.r.o. buys from the manufacturer directly. Both are ordinary:
 * the Monday board is full of orders with no depot at all (Takamiya, Heras,
 * Cision, the cutting-station parts), and hub_approve_po_leg already handles a
 * chain that starts at either of them.
 *
 * Pure: no database and no server-only import, so the form, the server action
 * and the tests all read the same table.
 */

import type { ProductEntityCodes } from '@/lib/erp-types'
import type { PurchaseOrder } from '@/lib/erp-types'
import { type OrgCode } from '@/lib/organisations'

/**
 * Every column of product_code_master that holds a Xero item code.
 *
 * Wider than ProductEntityCodes, which the create page selected from and which
 * carried only the five columns the three original depots needed. France and
 * the UK have had their codes in the table all along; nothing read them.
 */
export interface ProductXeroCodes extends ProductEntityCodes {
  code_france: string | null
  code_uk: string | null
}

export type XeroCodeColumn = keyof Omit<ProductXeroCodes, 'internal_sku'>

/** The columns to select from product_code_master. Derived, so adding a party
 *  below cannot leave its column unfetched. */
export const XERO_CODE_COLUMNS: readonly XeroCodeColumn[] = [
  'code_usa_balt',
  'code_usa_sb',
  'code_canada',
  'code_france',
  'code_uk',
  'code_grp',
  'code_sro',
]

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
  /**
   * The product_code_master column holding this party's Xero item code.
   *
   * Null means the party has no item codes at all, so it cannot raise anything
   * yet and the form says why. Australia is the only one: product_code_master
   * has no Australian column, which is a fact about the data and not an
   * oversight here.
   */
  codeColumn: XeroCodeColumn | null
  /** The purchase order number series. Mirrors public.hub_po_prefix_for_depot. */
  series: string
  /**
   * Why this party is not live YET, or null when it is.
   *
   * 🔴 Deliberately separate from codeColumn being null. That one is a fact
   * about the data; this one is a fact about what has been deployed, and it
   * exists because the Hub half of this work can reach hub.echobarrier.com
   * before the migration is applied and before n8n Fz7xXgifva5n548u is
   * republished. Offering France in the dropdown while n8n still routes it by
   * `from_entity === 'CA-HAM' ? Canada : USA` would put a French purchase order
   * in the UNITED STATES Xero organisation. Dave holds GB-BSE and EU-FR, so
   * that is a real person doing a real thing, not a hypothetical.
   *
   * Clear each line in the SAME sitting as the change it names.
   */
  pending: string | null
}

/**
 * The registry, in the order the dropdown shows them: depots first, then the
 * two companies that buy on their own account.
 *
 * `series` must stay identical to public.hub_po_prefix_for_depot for the depot
 * leg; tests/unit/po-numbering-schema-coherence.test.ts has pinned that since
 * the scheme landed and now reads this table.
 */
export const RAISING_PARTIES: readonly RaisingParty[] = [
  { code: 'US-BAL', label: 'US Baltimore', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-USA', codeColumn: 'code_usa_balt', series: 'EBUSA', pending: null },
  { code: 'US-SBD', label: 'US San Bernardino', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-USA', codeColumn: 'code_usa_sb', series: 'EBUSA', pending: null },
  { code: 'CA-HAM', label: 'Canada Hamilton', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-CANADA', codeColumn: 'code_canada', series: 'EBCAN', pending: null },
  { code: 'EU-FR', label: 'France', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-FRANCE', codeColumn: 'code_france', series: 'EBFRA', pending: 'n8n Fz7xXgifva5n548u still picks the Xero organisation itself and would create this order in the USA organisation with US Baltimore item codes. It also has no EB Group supplier contact for the French Xero organisation.' },
  { code: 'GB-BSE', label: 'UK Bury St Edmunds', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-UK', codeColumn: 'code_uk', series: 'EBUK', pending: 'The EBUK number series is in a migration that has not been applied, and n8n would create this order in the USA Xero organisation. It also has no EB Group supplier contact for the UK Xero organisation.' },
  // 🔴 Has a number series and a Xero organisation, and NO item codes: there is
  // no Australian column on product_code_master. Listed so the compiler, the
  // database function and this file agree about it, and refused by
  // canRaiseFor() with a reason rather than quietly missing from the dropdown.
  { code: 'AU-SYD', label: 'Australia Sydney', leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-AUSTRALIA', codeColumn: null, series: 'EBAUS', pending: null },
  { code: 'EB-GROUP', label: 'Group (buying from s.r.o.)', leg: 'EB_GROUP_TO_SRO', to: 'EB-SRO', org: 'EB-GROUP', codeColumn: 'code_grp', series: 'EBGRP', pending: null },
  { code: 'EB-SRO', label: 's.r.o. (buying from the manufacturer)', leg: 'SRO_TO_SUPPLIER', to: 'SUPPLIER', org: 'EB-SRO', codeColumn: 'code_sro', series: 'EBSRO', pending: 'A standalone s.r.o. order needs the EBSRO series from a migration that has not been applied, and the SRO_TO_SUPPLIER branch in n8n is switched off with a placeholder supplier contact, so the order would reach no Xero organisation at all.' },
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
  if (!party.codeColumn) {
    return `${party.label} has no Xero product codes in product_code_master, so its order would reach Xero with no line items. Add its column before raising orders for it.`
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

/**
 * This party's Xero item code for a product, or null when the product has none.
 *
 * `codes` is a product_code_master row. Trimmed because at least one live value
 * carries trailing spaces ("V2BALT  "), and a Xero ItemCode with a trailing
 * space does not match the item.
 */
export function xeroItemCode(party: RaisingParty, codes: Partial<ProductXeroCodes> | undefined): string | null {
  if (!party.codeColumn || !codes) return null
  const value = codes[party.codeColumn]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? null : trimmed
}

export interface CatalogueEntry {
  sku: string
  product_name: string | null
  product_family: string | null
  internal_sku: string | null
}

/**
 * The products this party may put on an order: the ones that have a Xero item
 * code in ITS column.
 *
 * Dean, 21 Sep 2026: "The line items have to be loaded depot specific." This is
 * that, and it needs no new table. A product with no code for this party cannot
 * be ordered by it, because the order would reach Xero without that line: the
 * n8n builder drops an unmapped line into `unmapped_skus` and carries on, so
 * today a French order for a product with no code_france would arrive in Xero
 * SHORT A LINE and nobody would be told. Better that it was never offered.
 *
 * Returns the code alongside the product so the form can show what Xero will
 * receive, which is the only way anyone will notice a wrong mapping.
 */
export function catalogueFor<T extends CatalogueEntry>(
  party: RaisingParty,
  catalogue: readonly T[],
  codesByInternalSku: ReadonlyMap<string, Partial<ProductXeroCodes>>,
): { item: T; xeroItemCode: string }[] {
  const out: { item: T; xeroItemCode: string }[] = []
  for (const item of catalogue) {
    if (!item.internal_sku) continue
    const code = xeroItemCode(party, codesByInternalSku.get(item.internal_sku))
    if (code) out.push({ item, xeroItemCode: code })
  }
  return out
}

/** Index a product_code_master result by internal_sku. */
export function indexCodes(
  rows: readonly Partial<ProductXeroCodes>[],
): Map<string, Partial<ProductXeroCodes>> {
  const map = new Map<string, Partial<ProductXeroCodes>>()
  for (const row of rows) {
    const key = typeof row.internal_sku === 'string' ? row.internal_sku : ''
    if (key !== '') map.set(key, row)
  }
  return map
}
