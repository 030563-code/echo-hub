import { createServerClient } from "@/lib/supabase/server";
import PurchasingClient from "./purchasing-client";
import type { PurchaseOrder } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const supabase = await createServerClient();

  const { data: orders } = await supabase
    .from("purchase_orders")
    .select("*, lines:purchase_order_lines(*)")
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Supplier & PO Tracker
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Intercompany purchase orders — Depots → EB Group → EB SRO
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total Active", value: orders?.length ?? 0, color: "text-white" },
          { label: "In Manufacturing", value: orders?.filter((o) => o.status === "in_manufacturing").length ?? 0, color: "text-purple-300" },
          { label: "Shipped", value: orders?.filter((o) => o.status === "shipped").length ?? 0, color: "text-indigo-300" },
          { label: "Awaiting Approval", value: orders?.filter((o) => o.status === "requested").length ?? 0, color: "text-blue-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
            <p className="text-[#6b7280] text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <PurchasingClient orders={(orders ?? []) as PurchaseOrder[]} />
    </div>
  );
}
