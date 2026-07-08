"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { buildCommercialInvoice, type CommercialInvoiceDoc, type CommercialInvoiceFx } from "@/lib/commercial-invoice";
import { applyComposition, type CompositionRule, type HsCodeEntry } from "@/lib/invoice-composition";
import { getEurUsdRate } from "@/lib/fx-helper";

// ---------------------------------------------------------------------------
// Generate + persist a commercial invoice for one CONTAINER (it "travels with
// the container"). Two legs:
//   SRO_TO_GROUP — EUR, values straight from intercompany_prices.
//   GROUP_TO_USA — USD, EUR base × rolling-13-week EUR_USD (snapshotted on the doc).
// Aggregate the container's shipment_contents by SKU, value, number+persist
// header+lines ATOMICALLY (service-role RPC). Hub-PDF + DB only (no Xero).
// Gated invoice.create AND cost.view (values shown).
// ---------------------------------------------------------------------------

const Input = z.object({
  container_ref: z.string().trim().min(1).max(120),
  leg: z.enum(["SRO_TO_GROUP", "GROUP_TO_USA"]).default("SRO_TO_GROUP"),
  // Destination country (e.g. 'BR') drives country-specific composition rules
  // (Brazil bundling). Optional — intercompany legs may have no customer country.
  destination_country: z.string().trim().max(60).optional(),
});

type Leg = "SRO_TO_GROUP" | "GROUP_TO_USA";
const LEG_CONFIG: Record<Leg, { seller: string; buyer: string; currency: string; usesFx: boolean }> = {
  SRO_TO_GROUP: { seller: "EB-SRO", buyer: "EB-GROUP", currency: "EUR", usesFx: false },
  GROUP_TO_USA: { seller: "EB-GROUP", buyer: "EB-USA", currency: "USD", usesFx: true },
};

export type GenerateInvoiceResult =
  | { ok: true; doc: CommercialInvoiceDoc; warnings: string[] }
  | { ok: false; error: string };

interface ShipmentRow {
  sku: string;
  product_name: string | null;
  qty: number;
  po_reference: string | null;
  spot_id: string | null;
}
interface EntityRow {
  code: string;
  legal_name: string;
  address_lines: string[] | null;
  vat_tax_id: string | null;
}

export async function generateCommercialInvoice(input: { container_ref: string; leg?: Leg; destination_country?: string }): Promise<GenerateInvoiceResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  // Issuing a priced commercial document requires BOTH capabilities.
  if (!auth.capabilities.has("invoice.create") || !auth.capabilities.has("cost.view")) {
    return { ok: false, error: "Forbidden: needs invoice.create + cost.view" };
  }

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid container reference" };
  const container = parsed.data.container_ref;
  const leg = parsed.data.leg;
  const destinationCountry = parsed.data.destination_country?.toUpperCase() ?? null;
  const cfg = LEG_CONFIG[leg];
  const { user } = auth;

  const supabase = await createServerClient();

  // 1. The container's shipment lines (the "travels with the container" source).
  const { data: contents, error: contentsErr } = await supabase
    .from("shipment_contents")
    .select("sku, product_name, qty, po_reference, spot_id")
    .eq("container_ref", container);
  if (contentsErr) return { ok: false, error: "Could not load the container's shipment lines." };
  const rows = (contents ?? []) as ShipmentRow[];
  if (!rows.length) return { ok: false, error: "No shipment lines found for that container." };

  // Duplicate guard: refuse a second live invoice for the same container + leg
  // (a partial unique index backs this at the DB level too). Void the existing
  // one first to re-issue. Read via service-role so it works regardless of the
  // caller's invoice.view grant.
  const guard = createAdminClient();
  const { data: existing } = await guard
    .from("commercial_invoices")
    .select("invoice_number")
    .eq("container_ref", container)
    .eq("leg", leg)
    .neq("status", "void")
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      error: `Invoice ${(existing as { invoice_number?: string }).invoice_number ?? ""} already exists for this container + leg. Void it first to re-issue.`,
    };
  }

  // 2. Parties for the leg.
  const { data: ents, error: entErr } = await supabase
    .from("entities")
    .select("code, legal_name, address_lines, vat_tax_id")
    .in("code", [cfg.seller, cfg.buyer]);
  if (entErr) return { ok: false, error: "Could not load invoice entities." };
  const byCode = new Map((ents ?? []).map((e) => [(e as EntityRow).code, e as EntityRow]));
  const seller = byCode.get(cfg.seller);
  const buyer = byCode.get(cfg.buyer);
  if (!seller || !buyer) return { ok: false, error: "Seller/buyer entity not configured." };

  // 3. Transfer prices (EUR base) for the leg. Capture the error so a failed read
  // can't be laundered into a silent value-0 invoice.
  const skus = [...new Set(rows.map((r) => r.sku))];
  const { data: prices, error: priceErr } = await supabase
    .from("intercompany_prices")
    .select("sku, unit_value")
    .eq("leg", leg)
    .eq("active", true)
    .in("sku", skus);
  if (priceErr) return { ok: false, error: "Could not load transfer prices." };
  const priceBySku = new Map<string, number>();
  for (const p of prices ?? []) {
    const row = p as { sku: string; unit_value: number };
    const v = Number(row.unit_value);
    if (Number.isFinite(v)) priceBySku.set(row.sku, v);
  }

  // 4. FX (USD leg only) — QUARTER-STABLE EUR_USD (Juraj: "3-mo avg, updated
  // quarterly"), snapshotted onto the doc so an issued invoice never re-derives.
  let fx: CommercialInvoiceFx | null = null;
  const fxNotes: string[] = [];
  if (cfg.usesFx) {
    const rate = await getEurUsdRate("quarterly");
    if (!rate) return { ok: false, error: "EUR→USD FX rate unavailable (mfg fx_weekly)." };
    fx = { pair: rate.pair, rate: rate.rate, method: rate.method, week_start: rate.week_start };
    fxNotes.push(`USD @ ${rate.rate} — ${rate.basis}.`);
    // Staleness: the frankfurter→fx_weekly sync is weekly and known to lag.
    if (rate.latest_week) {
      const ageDays = Math.floor((Date.now() - new Date(rate.latest_week).getTime()) / 86_400_000);
      if (ageDays > 14) fxNotes.push(`⚠ Newest FX week is ${rate.latest_week} (${ageDays} days old) — the FX feed may be stale.`);
    }
  }
  const fxMul = fx ? fx.rate : 1;

  // 5. Aggregate the container lines by SKU; value (EUR base × FX for the USD leg).
  const agg = new Map<string, { product_name: string; qty: number }>();
  for (const r of rows) {
    const cur = agg.get(r.sku) ?? { product_name: r.product_name ?? r.sku, qty: 0 };
    cur.qty += Number(r.qty) || 0;
    agg.set(r.sku, cur);
  }
  const docLines = [...agg.entries()].map(([sku, a]) => ({
    sku,
    product_name: a.product_name,
    qty: a.qty,
    unit_value: (priceBySku.get(sku) ?? 0) * fxMul,
    hs_code: null as string | null,
  }));
  const missingPrice = docLines.filter((l) => !priceBySku.has(l.sku)).map((l) => l.sku);

  // 5b. COMPOSITION — apply configured country/leg rules (consolidate ancillary
  // lines, split a SKU into per-leg HS-coded lines) + fill HS codes from the map.
  // Config read via service-role (guard) so it works regardless of invoice.view.
  // No-op (identity) when nothing matches → legacy invoices are unchanged.
  const [{ data: ruleRows }, { data: hsRows }] = await Promise.all([
    guard.from("invoice_composition_rules").select("id, active, country, leg, rule_type, source_sku, config, priority").eq("active", true),
    guard.from("product_hs_codes").select("sku, leg, hs_code"),
  ]);
  const composition = applyComposition(docLines, {
    leg,
    country: destinationCountry,
    rules: (ruleRows ?? []) as unknown as CompositionRule[],
    hsCodes: (hsRows ?? []) as unknown as HsCodeEntry[],
  });
  const composedLines = composition.lines;

  const spotId = rows.find((r) => r.spot_id)?.spot_id ?? null;
  // A container can carry lines from MORE THAN ONE PO — keep every distinct ref
  // on the invoice, don't silently attribute the whole doc to the first one.
  const poRefs = [...new Set(rows.map((r) => r.po_reference).filter((x): x is string => !!x))].sort();
  const poRef = poRefs.length ? poRefs.join(", ") : null;

  // 6. Build the doc, then persist + number ATOMICALLY in one service-role RPC
  // (header + lines in a single transaction — a line failure rolls the whole
  // invoice back, so there's never an orphaned header). Number allocated in the RPC.
  const isoDate = new Date().toISOString().slice(0, 10);
  const doc = buildCommercialInvoice({
    invoice_number: "",
    date: isoDate,
    leg,
    seller: { code: cfg.seller, legal_name: seller.legal_name, address_lines: seller.address_lines ?? [], vat_tax_id: seller.vat_tax_id },
    buyer: { code: cfg.buyer, legal_name: buyer.legal_name, address_lines: buyer.address_lines ?? [], vat_tax_id: buyer.vat_tax_id },
    container_ref: container,
    spot_id: spotId,
    po_reference: poRef,
    currency: cfg.currency,
    lines: composedLines,
    fx,
  });

  const admin = createAdminClient();
  const { data: created, error: rpcErr } = await admin.rpc("create_commercial_invoice", {
    p_header: {
      leg,
      seller_entity_code: cfg.seller,
      buyer_entity_code: cfg.buyer,
      shipment_spot_id: spotId,
      container_ref: container,
      po_reference: poRef,
      currency: cfg.currency,
      destination_country: destinationCountry,
      fx_pair: fx?.pair ?? null,
      fx_rate: fx?.rate ?? null,
      fx_method: fx?.method ?? null,
      fx_week_start: fx?.week_start ?? null,
      subtotal: doc.subtotal,
      tax_total: doc.tax_total,
      total: doc.total,
      status: "draft",
      created_by_uid: user.id,
    },
    p_lines: doc.lines.map((l, i) => ({
      sku: l.sku,
      product_name: l.product_name,
      qty: l.qty,
      unit_value: l.unit_value ?? 0,
      line_total: l.line_total ?? 0,
      hs_code: l.hs_code,
      container_ref: container,
      sort_order: i,
    })),
  });
  const invoiceNumber = (created as { invoice_number?: string } | null)?.invoice_number ?? null;
  if (rpcErr || !invoiceNumber) {
    console.error("generateCommercialInvoice RPC failed", rpcErr?.message);
    return { ok: false, error: "Could not save the invoice." };
  }

  revalidatePath("/transport");

  const warnings = [
    ...composition.applied,
    ...fxNotes,
    ...(missingPrice.length
      ? [`No transfer price set for: ${missingPrice.join(", ")} — valued at 0. Set them in intercompany_prices.`]
      : []),
  ];
  return { ok: true, doc: { ...doc, invoice_number: invoiceNumber }, warnings };
}
