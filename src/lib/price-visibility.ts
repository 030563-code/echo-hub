import type { BamidaPo } from './bamida-po'
import type { CommercialInvoiceDoc } from './commercial-invoice'
import type { BomMasterRow, PurchaseOrder, SroPoBom } from './erp-types'

/**
 * Cost-visibility stripping for the `cost.view` capability.
 *
 * Without `cost.view` (warehouse/production "workers"), every price/cost is
 * removed SERVER-SIDE before the data reaches the client — so it's absent from
 * the UI *and* from generated PDFs, not merely CSS-hidden. The matching client
 * components also take a `canViewCost` flag to drop the now-empty columns/labels.
 *
 * Pure functions (no 'server-only') so they're unit-testable; only ever called
 * from server components.
 */

/** Null `unit_price` on every PO line unless the viewer holds cost.view. */
export function stripPurchaseOrderCosts(orders: PurchaseOrder[], canViewCost: boolean): PurchaseOrder[] {
  if (canViewCost) return orders
  return orders.map((o) => ({
    ...o,
    lines: o.lines?.map((l) => ({ ...l, unit_price: null })),
  }))
}

/** Zero every EUR figure on an exploded SRO-PO BOM unless the viewer holds cost.view. */
export function stripSroPoBomCosts(po: SroPoBom, canViewCost: boolean): SroPoBom {
  if (canViewCost) return po
  return {
    ...po,
    bamida_total: 0,
    sro_total: 0,
    lines: po.lines.map((l) => ({
      ...l,
      bamida_man_eur: 0,
      bamida_print_eur: 0,
      components_eur_unit: 0,
      bamida_total_line: 0,
      sro_total_line: 0,
      components: l.components.map((c) => ({ ...c, unit_cost_eur: 0, extended_eur: 0, line_extended_eur: 0 })),
    })),
  }
}

/** Null every cost on the master BOM rows unless the viewer holds cost.view. */
export function stripBomMasterCosts(rows: BomMasterRow[], canViewCost: boolean): BomMasterRow[] {
  if (canViewCost) return rows
  return rows.map((r) => ({
    ...r,
    bamida_man_eur: null,
    bamida_print_eur: null,
    bamida_total_eur: null,
    sro_components_eur: null,
    sro_duty_8pct_eur: null,
    sro_admin_eur: null,
    sro_total_eur: null,
    bom_total_eur: null,
    // The pre-edit snapshot total is still a EUR cost — null it too, or it leaks
    // into the RSC payload for a bom.view viewer without cost.view.
    original_bom_total_eur: null,
    fx_gbp_eur: null,
    bom_change_pct: null,
    component_detail: r.component_detail.map((c) => ({ ...c, unit_cost_eur: 0, extended_eur: 0 })),
  }))
}

/**
 * Turn a Bamida supplier PO into the price-less "BOM PO" (codes/specs/qty only)
 * for a viewer without cost.view. Lines are kept (the manufacturer needs them);
 * all money is nulled and `priced` flips to false so the renderer drops the
 * price/amount/tax columns and the totals.
 */
export function stripBamidaPo(bp: BamidaPo): BamidaPo {
  return {
    ...bp,
    lines: bp.lines.map((l) => ({ ...l, price: null, amount: null, taxRate: null })),
    subtotal: null,
    tax: null,
    total: null,
    priced: false,
  }
}

/**
 * Strip all values off a commercial invoice for a viewer without cost.view — the
 * doc keeps its parties/container/line SKUs+qty but every monetary figure (and the
 * FX block) is nulled, and `priced` flips false so the renderer drops the columns.
 */
export function stripCommercialInvoice(doc: CommercialInvoiceDoc): CommercialInvoiceDoc {
  return {
    ...doc,
    lines: doc.lines.map((l) => ({ ...l, unit_value: null, line_total: null })),
    subtotal: null,
    tax_total: null,
    total: null,
    fx: null,
    priced: false,
  }
}
