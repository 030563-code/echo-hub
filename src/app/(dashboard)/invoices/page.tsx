import { createServerClient } from "@/lib/supabase/server";
import { getCapabilities } from "@/lib/authz";
import { commercialInvoiceDocFromRecord, type CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { stripCommercialInvoice } from "@/lib/price-visibility";
import InvoicesClient from "./invoices-client";
import type { CommercialInvoice, CommercialInvoiceLineRow, Entity } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export interface InvoiceListRow {
  id: string;
  status: string;
  doc: CommercialInvoiceDoc;
}

export default async function InvoicesPage() {
  const supabase = await createServerClient();
  const caps = await getCapabilities();
  const canViewCost = caps.has("cost.view");
  const canManage = caps.has("invoice.create");

  const { data: invs } = await supabase
    .from("commercial_invoices")
    .select("*")
    .order("created_at", { ascending: false });
  const headers = (invs ?? []) as CommercialInvoice[];

  // Lines per invoice.
  const ids = headers.map((h) => h.id);
  const linesByInv = new Map<string, CommercialInvoiceLineRow[]>();
  if (ids.length) {
    const { data: lns } = await supabase.from("commercial_invoice_lines").select("*").in("invoice_id", ids);
    for (const l of (lns ?? []) as CommercialInvoiceLineRow[]) {
      const arr = linesByInv.get(l.invoice_id) ?? [];
      arr.push(l);
      linesByInv.set(l.invoice_id, arr);
    }
  }

  // Parties.
  const codes = [...new Set(headers.flatMap((h) => [h.seller_entity_code, h.buyer_entity_code]))];
  const entByCode = new Map<string, Entity>();
  if (codes.length) {
    const { data: ents } = await supabase.from("entities").select("*").in("code", codes);
    for (const e of (ents ?? []) as Entity[]) entByCode.set(e.code, e);
  }
  const party = (code: string) => {
    const e = entByCode.get(code);
    return { code, legal_name: e?.legal_name ?? code, address_lines: e?.address_lines ?? [], vat_tax_id: e?.vat_tax_id ?? null };
  };

  const rows: InvoiceListRow[] = headers.map((h) => {
    const lines = (linesByInv.get(h.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    let doc = commercialInvoiceDocFromRecord({
      invoice_number: h.invoice_number,
      date: (h.created_at ?? "").slice(0, 10),
      leg: h.leg,
      currency: h.currency,
      container_ref: h.container_ref,
      spot_id: h.shipment_spot_id,
      po_reference: h.po_reference,
      subtotal: h.subtotal,
      tax_total: h.tax_total,
      total: h.total,
      fx_pair: h.fx_pair,
      fx_rate: h.fx_rate,
      fx_method: h.fx_method,
      fx_week_start: h.fx_week_start,
      seller: party(h.seller_entity_code),
      buyer: party(h.buyer_entity_code),
      lines: lines.map((l) => ({ sku: l.sku, product_name: l.product_name, qty: l.qty, unit_value: l.unit_value, line_total: l.line_total, hs_code: l.hs_code })),
    });
    // The cost-stripping path: a viewer with invoice.view but NOT cost.view gets
    // the invoice with every value nulled (server-side, before it reaches them).
    if (!canViewCost) doc = stripCommercialInvoice(doc);
    return { id: h.id, status: h.status, doc };
  });

  return <InvoicesClient invoices={rows} canViewCost={canViewCost} canManage={canManage} />;
}
