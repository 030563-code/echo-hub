// Pure builder for an intercompany COMMERCIAL INVOICE that "travels with the
// container". v1 = the EUR SRO→Group leg; the FX block (for the USD Group→USA leg,
// rolling-13-week avg) is modelled but null on the EUR leg. Values come from the
// intercompany_prices transfer-price list (snapshotted onto the invoice at issue).
//
// Pure (no 'server-only') so it's unit-testable; called only from server code.

export interface CommercialInvoiceParty {
  code: string
  legal_name: string
  address_lines: string[]
  vat_tax_id: string | null
}

export interface CommercialInvoiceLine {
  sku: string
  product_name: string
  qty: number
  // Null on a price-less render (a viewer without cost.view).
  unit_value: number | null
  line_total: number | null
  hs_code: string | null
}

export interface CommercialInvoiceFx {
  pair: string
  rate: number
  method: string // 'rolling_13w' | 'spot'
  week_start: string | null
}

export interface CommercialInvoiceDoc {
  invoice_number: string
  date: string // ISO yyyy-mm-dd (caller supplies)
  leg: string
  seller: CommercialInvoiceParty
  buyer: CommercialInvoiceParty
  container_ref: string | null
  spot_id: string | null
  po_reference: string | null
  currency: string
  lines: CommercialInvoiceLine[]
  subtotal: number | null
  tax_total: number | null
  total: number | null
  /** Set on the USD leg only; null for EUR SRO→Group. */
  fx: CommercialInvoiceFx | null
  /** false = values stripped for a viewer without cost.view. */
  priced: boolean
}

export interface BuildCommercialInvoiceInput {
  invoice_number: string
  date: string
  leg: string
  seller: CommercialInvoiceParty
  buyer: CommercialInvoiceParty
  container_ref: string | null
  spot_id: string | null
  po_reference: string | null
  currency: string
  lines: { sku: string; product_name: string; qty: number; unit_value: number; hs_code: string | null }[]
  fx?: CommercialInvoiceFx | null
}

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * Rebuild a doc from a PERSISTED invoice (header + lines + parties) for the
 * list/view — uses the STORED values verbatim (an issued document is never
 * recomputed; Postgres numerics may arrive as strings, so coerce). The caller
 * applies stripCommercialInvoice() for a viewer without cost.view.
 */
export function commercialInvoiceDocFromRecord(r: {
  invoice_number: string
  date: string
  leg: string
  currency: string
  container_ref: string | null
  spot_id: string | null
  po_reference: string | null
  subtotal: number | string
  tax_total: number | string
  total: number | string
  fx_pair: string | null
  fx_rate: number | string | null
  fx_method: string | null
  fx_week_start: string | null
  seller: CommercialInvoiceParty
  buyer: CommercialInvoiceParty
  lines: { sku: string; product_name: string; qty: number | string; unit_value: number | string; line_total: number | string; hs_code: string | null }[]
}): CommercialInvoiceDoc {
  const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v))
  const fxRate = r.fx_rate == null ? null : Number(r.fx_rate)
  const fx: CommercialInvoiceFx | null =
    fxRate != null && r.fx_pair ? { pair: r.fx_pair, rate: fxRate, method: r.fx_method ?? '', week_start: r.fx_week_start } : null
  return {
    invoice_number: r.invoice_number,
    date: r.date,
    leg: r.leg,
    seller: r.seller,
    buyer: r.buyer,
    container_ref: r.container_ref,
    spot_id: r.spot_id,
    po_reference: r.po_reference,
    currency: r.currency,
    lines: r.lines.map((l) => ({
      sku: l.sku,
      product_name: l.product_name,
      qty: n(l.qty),
      unit_value: n(l.unit_value),
      line_total: n(l.line_total),
      hs_code: l.hs_code,
    })),
    subtotal: n(r.subtotal),
    tax_total: n(r.tax_total),
    total: n(r.total),
    fx,
    priced: true,
  }
}

export interface EditableInvoiceLine {
  sku: string
  product_name: string
  qty: number
  unit_value: number
  hs_code: string | null
}

/**
 * Recompute an invoice's line_totals + header totals from edited lines (the
 * editable-draft override). Rounds unit_value FIRST, then derives line_total, so
 * a saved draft always satisfies unit_value × qty = line_total. tax_total is
 * carried through (0 for intercompany export). This is the reconciliation the
 * draft editor relies on — totals can never drift out of sync with the lines.
 */
export function reconcileInvoiceLines(
  lines: EditableInvoiceLine[],
  taxTotal = 0
): { lines: (EditableInvoiceLine & { line_total: number })[]; subtotal: number; tax_total: number; total: number } {
  const out = lines.map((l) => {
    const unit_value = round2(l.unit_value)
    return { ...l, unit_value, line_total: round2(l.qty * unit_value) }
  })
  const subtotal = round2(out.reduce((s, l) => s + l.line_total, 0))
  return { lines: out, subtotal, tax_total: taxTotal, total: round2(subtotal + taxTotal) }
}

export function buildCommercialInvoice(input: BuildCommercialInvoiceInput): CommercialInvoiceDoc {
  const lines: CommercialInvoiceLine[] = input.lines.map((l) => {
    // Round the unit value FIRST, then derive line_total from it, so the persisted
    // columns always satisfy unit_value × qty = line_total (a >2dp transfer price
    // can't make the printed line fail to re-multiply on a customs document).
    const unit_value = round2(l.unit_value)
    return {
      sku: l.sku,
      product_name: l.product_name,
      qty: l.qty,
      unit_value,
      line_total: round2(l.qty * unit_value),
      hs_code: l.hs_code,
    }
  })
  // Intercompany export invoice — no VAT line (0-rated). tax_total stays 0.
  const subtotal = round2(lines.reduce((s, l) => s + (l.line_total ?? 0), 0))
  const tax_total = 0
  return {
    invoice_number: input.invoice_number,
    date: input.date,
    leg: input.leg,
    seller: input.seller,
    buyer: input.buyer,
    container_ref: input.container_ref,
    spot_id: input.spot_id,
    po_reference: input.po_reference,
    currency: input.currency,
    lines,
    subtotal,
    tax_total,
    total: round2(subtotal + tax_total),
    fx: input.fx ?? null,
    priced: true,
  }
}
