import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCapability } from "@/lib/authz";
import { createServerClient } from "@/lib/supabase/server";
import ApprovalsClient from "./approvals-client";
import type { PurchaseOrder } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  await requireCapability("po.approve");
  const supabase = await createServerClient();

  // All Hub-raised legs still awaiting approval, across the three tiers
  // (Depot → Group → SRO). n8n-raised rows (source='n8n') keep their own Slack
  // gate and never appear here.
  const { data: pending } = await supabase
    .from("purchase_orders")
    .select("*, lines:purchase_order_lines(*)")
    .eq("source", "hub")
    .eq("status", "requested")
    .order("created_at", { ascending: true });

  const orders = (pending ?? []) as PurchaseOrder[];

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
          PO Approvals
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Three-tier approval — Depot → Group → SRO. Each approval authorises that tier&apos;s Xero PO and raises the next.
        </p>
      </div>

      <ApprovalsClient orders={orders} />
    </div>
  );
}
