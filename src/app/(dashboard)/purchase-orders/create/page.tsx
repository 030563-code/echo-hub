import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { RAISABLE_PARTIES, XERO_CODE_COLUMNS, type ProductXeroCodes } from "@/lib/po-raising";
import { createServerClient } from "@/lib/supabase/server";
import RaisePOForm from "./raise-po-form";
import type { PoProductCatalogItem, PoDeliveryAddress, PoHsCode, PoTemplate } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

// Who may raise, and what their order is, now comes from src/lib/po-raising.ts.
// It used to be a hardcoded V1_DEPOTS = ["US-BAL","US-SBD","CA-HAM"] here, a
// second map in the form, a third in po-number.ts and a fourth in n8n, and the
// four had drifted apart. Dean, 21 Sep 2026: add EU-FR, GB-BSE, EB-GROUP and
// EB-SRO.

export default async function RaisePOPage() {
  const auth = await requireCapability("po.create");
  const supabase = await createServerClient();

  const [{ data: catalog }, { data: addresses }, { data: hsCodes }, { data: codes }, { data: templates }, { data: stock }] =
    await Promise.all([
      supabase.from("po_product_catalog").select("*").eq("active", true).order("product_family").order("sku"),
      supabase.from("po_delivery_addresses").select("*").eq("active", true).order("entity"),
      supabase.from("po_hs_codes").select("*").eq("active", true).order("code"),
      // EVERY code column, derived from the registry. France's and the UK's
      // codes have been in this table all along and nothing selected them.
      supabase
        .from("product_code_master")
        .select(["internal_sku", ...XERO_CODE_COLUMNS].join(", "))
        .eq("is_active", true),
      // RLS restricts po_templates SELECT to po.create holders (this page is po.create-gated).
      supabase.from("po_templates").select("*").order("name"),
      // Stock for the non-blocking shortfall flag (dummy until the stocktake lands).
      supabase.from("warehouse_stock_levels").select("sku, quantity_on_hand"),
    ]);

  // Templates carry unit_price in their lines jsonb → strip it for raisers who
  // lack cost.view (keeps slice-3 price hiding consistent; the po.create⇒cost.view
  // grant coupling is an invariant, but defend it here regardless).
  const canViewCost = auth.capabilities.has("cost.view");
  const templatesSafe = ((templates ?? []) as PoTemplate[]).map((t) =>
    canViewCost ? t : { ...t, lines: (t.lines ?? []).map((l) => ({ ...l, unit_price: null })) }
  );

  const stockBySku: Record<string, number> = {};
  for (const r of (stock ?? []) as { sku: string; quantity_on_hand: number }[]) {
    stockBySku[r.sku] = (stockBySku[r.sku] ?? 0) + (r.quantity_on_hand ?? 0);
  }

  // The raising party must belong to an organisation the caller holds, and a
  // depot must also be one of their own. Group and s.r.o. carry no depot code,
  // so holding the organisation is the whole test for them.
  const allowed = auth.profile.allowed_depots ?? [];
  const anyDepot = auth.profile.is_super_admin || allowed.includes("ALL");
  const parties = RAISABLE_PARTIES.filter(
    (p) =>
      auth.profile.organisations.includes(p.org) &&
      (p.leg !== "DEPOT_TO_EB_GROUP" || anyDepot || allowed.includes(p.code)),
  ).map((p) => ({ code: p.code, label: p.label, leg: p.leg, to: p.to }));

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Purchase Orders
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Raise Purchase Order
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          A branch raises a PO to EB Group — it enters the approval queue, then flows to EB SRO.
        </p>
      </div>

      <RaisePOForm
        parties={parties}
        catalog={(catalog ?? []) as PoProductCatalogItem[]}
        addresses={(addresses ?? []) as PoDeliveryAddress[]}
        hsCodes={(hsCodes ?? []) as PoHsCode[]}
        entityCodes={(codes ?? []) as unknown as Partial<ProductXeroCodes>[]}
        templates={templatesSafe}
        stockBySku={stockBySku}
        canViewCost={canViewCost}
      />
    </div>
  );
}
