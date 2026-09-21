import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { activeOrganisation } from "@/lib/active-organisation.server";
import { orgLabel, partiesForOrg } from "@/lib/organisations";
import { RAISABLE_PARTIES, RAISING_PARTIES, raisingBlockedReason, XERO_CODE_COLUMNS, type ProductXeroCodes } from "@/lib/po-raising";
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

  // The organisation being looked at is the OUTER scope, in the query and in
  // the form. Dean, 21 Sep 2026: "if I am in UK country mode for the Hub as a
  // whole it should only show me the UK depot and UK delivery address as well
  // as the UK line items only". The raising party must belong to that
  // organisation, a depot must also be one of the caller's own, and the
  // delivery addresses are the organisation's parties' and no other's. The
  // line items already follow the selected party.
  const org = await activeOrganisation(auth);
  const allowed = auth.profile.allowed_depots ?? [];
  const anyDepot = auth.profile.is_super_admin || allowed.includes("ALL");
  const parties = org
    ? RAISABLE_PARTIES.filter(
        (p) => p.org === org && (p.leg !== "DEPOT_TO_EB_GROUP" || anyDepot || allowed.includes(p.code)),
      ).map((p) => ({ code: p.code, label: p.label, leg: p.leg, to: p.to }))
    : [];
  // Why the list is empty, in a sentence the form can show.
  let reason: string | null = null;
  if (!org) {
    reason = "Choose an organisation in the header first.";
  } else if (parties.length === 0) {
    const own = RAISING_PARTIES.filter((p) => p.org === org);
    const blocked = own.map((p) => raisingBlockedReason(p.code)).find(Boolean);
    reason =
      blocked ??
      (own.length
        ? `Your account is not assigned the ${orgLabel(org)} depot (${own.map((p) => p.code).join(", ")}). Ask an administrator.`
        : `${orgLabel(org)} has no raising party.`);
  }
  const orgParties = new Set(org ? partiesForOrg(org) : []);
  const addressesForOrg = ((addresses ?? []) as PoDeliveryAddress[]).filter((a) => orgParties.has(a.entity));
  const partyCodes = new Set(parties.map((p) => p.code));
  const templatesForOrg = templatesSafe.filter((t) => !t.from_entity || partyCodes.has(t.from_entity));

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
        reason={reason}
        catalog={(catalog ?? []) as PoProductCatalogItem[]}
        addresses={addressesForOrg}
        hsCodes={(hsCodes ?? []) as PoHsCode[]}
        entityCodes={(codes ?? []) as unknown as Partial<ProductXeroCodes>[]}
        templates={templatesForOrg}
        stockBySku={stockBySku}
        canViewCost={canViewCost}
      />
    </div>
  );
}
