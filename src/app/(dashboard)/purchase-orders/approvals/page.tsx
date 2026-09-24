import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { activeOrganisation } from "@/lib/active-organisation.server";
import { chainFilter, chainsForOrg } from "@/lib/po-organisations";
import { NoOrganisationCard } from "@/components/organisations/no-organisation-card";
import { createServerClient } from "@/lib/supabase/server";
import { stripPurchaseOrderCosts } from "@/lib/price-visibility";
import { sendsToXero, unpricedLines, type UnpricedLine } from "@/lib/po-xero-send";
import { loadXeroSendFailures } from "@/lib/po-xero-send.server";
import XeroSendFailures from "@/components/po/xero-send-failures";
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
  // gate and never appear here. Alongside them, the approved legs whose send to
  // Xero failed, because approvers are the people who can send them again.
  const [{ data: pending }, failures] = await Promise.all([
    filter === null
      ? Promise.resolve({ data: [] as PurchaseOrder[] })
      : supabase
          .from("purchase_orders")
          .select("*, lines:purchase_order_lines(*)")
          .or(filter)
          .eq("source", "hub")
          .eq("status", "requested")
          .order("created_at", { ascending: true }),
    loadXeroSendFailures(supabase, filter),
  ]);

  // Which lines Xero would receive at 0, worked out before prices are stripped:
  // an approver without cost.view still has to be shown them to confirm them.
  const rows = (pending ?? []) as PurchaseOrder[];
  const unpricedByPo: Record<string, UnpricedLine[]> = {};
  for (const order of rows) {
    const lines = sendsToXero(order.leg) ? unpricedLines(order.lines ?? []) : [];
    if (lines.length > 0) unpricedByPo[order.id] = lines;
  }
  const orders = stripPurchaseOrderCosts(rows, canViewCost);

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

      {failures.length > 0 && (
        <div className="mb-6">
          <XeroSendFailures failures={failures} />
        </div>
      )}

      <ApprovalsClient orders={orders} canViewCost={canViewCost} unpricedByPo={unpricedByPo} />
    </div>
  );
}
