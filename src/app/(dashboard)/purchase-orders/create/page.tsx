import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { createServerClient } from "@/lib/supabase/server";
import RaisePOForm from "./raise-po-form";
import type { PoProductCatalogItem, PoDeliveryAddress, PoHsCode, ProductEntityCodes, PoTemplate } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

// US + Canada only for v1 (Dean 2026-06-15). Add AU/FR once they have entities.
const V1_DEPOTS = ["US-BAL", "US-SBD", "CA-HAM"];

export default async function RaisePOPage() {
  const auth = await requireCapability("po.create");
  const supabase = await createServerClient();

  const [{ data: catalog }, { data: addresses }, { data: hsCodes }, { data: codes }, { data: templates }, { data: stock }] =
    await Promise.all([
      supabase.from("po_product_catalog").select("*").eq("active", true).order("product_family").order("sku"),
      supabase.from("po_delivery_addresses").select("*").eq("active", true).order("entity"),
      supabase.from("po_hs_codes").select("*").eq("active", true).order("code"),
      supabase
        .from("product_code_master")
        .select("internal_sku, code_usa_balt, code_usa_sb, code_canada, code_grp, code_sro")
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

  // The raising depot must be one of the caller's own (super-admin / ALL → all v1).
  const allowed = auth.profile.allowed_depots ?? [];
  const depots =
    auth.profile.is_super_admin || allowed.includes("ALL")
      ? V1_DEPOTS
      : allowed.filter((d) => V1_DEPOTS.includes(d));

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1.5 text-xs text-[#6b7280] hover:text-[#e5e5e5] transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Purchase Orders
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Raise Purchase Order
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          A branch raises a PO to EB Group — it enters the approval queue, then flows to EB SRO.
        </p>
      </div>

      <RaisePOForm
        depots={depots}
        catalog={(catalog ?? []) as PoProductCatalogItem[]}
        addresses={(addresses ?? []) as PoDeliveryAddress[]}
        hsCodes={(hsCodes ?? []) as PoHsCode[]}
        entityCodes={(codes ?? []) as ProductEntityCodes[]}
        templates={templatesSafe}
        stockBySku={stockBySku}
        canViewCost={canViewCost}
      />
    </div>
  );
}
