import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { activeOrganisation } from "@/lib/active-organisation.server";
import { chainFilter, chainsForOrg } from "@/lib/po-organisations";
import { NoOrganisationCard } from "@/components/organisations/no-organisation-card";
import { createServerClient } from "@/lib/supabase/server";
import { stripPurchaseOrderCosts } from "@/lib/price-visibility";
import ApprovalsClient from "./approvals-client";
import type { PurchaseOrder } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const auth = await requireCapability("po.approve");
  const canViewCost = auth.capabilities.has("cost.view");
  const supabase = await createServerClient();

  // The organisation's chains only, same rule as the board.
  const org = await activeOrganisation(auth);
  if (!org) return <NoOrganisationCard title="PO Approvals" what="purchase orders" />;
  const filter = chainFilter(await chainsForOrg(supabase, org));

  // All Hub-raised legs still awaiting approval, across the three tiers
  // (Depot → Group → SRO). n8n-raised rows (source='n8n') keep their own Slack
  // gate and never appear here.
  const { data: pending } =
    filter === null
      ? { data: [] as PurchaseOrder[] }
      : await supabase
          .from("purchase_orders")
          .select("*, lines:purchase_order_lines(*)")
          .or(filter)
          .eq("source", "hub")
          .eq("status", "requested")
          .order("created_at", { ascending: true });

  const orders = stripPurchaseOrderCosts((pending ?? []) as PurchaseOrder[], canViewCost);

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
          PO Approvals
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Three-tier approval — Depot → Group → SRO. Each approval authorises that tier&apos;s Xero PO and raises the next.
        </p>
      </div>

      <ApprovalsClient orders={orders} canViewCost={canViewCost} />
    </div>
  );
}
