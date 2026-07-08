import Link from "next/link";
import { Plus, ClipboardCheck } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { getCapabilities } from "@/lib/authz";
import { stripPurchaseOrderCosts } from "@/lib/price-visibility";
import PurchasingClient from "./purchasing-client";
import type { PurchaseOrder, PoAttachment, PoShipment } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const supabase = await createServerClient();
  const caps = await getCapabilities();

  const { data: orders } = await supabase
    .from("purchase_orders")
    .select("*, lines:purchase_order_lines(*)")
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false });

  // Strip unit_price from the client payload for non-cost.view viewers — the board
  // doesn't render it, but it must not ship in the RSC payload either.
  const canViewCost = caps.has("cost.view");
  const all = stripPurchaseOrderCosts((orders ?? []) as PurchaseOrder[], canViewCost);
  const pendingApproval = all.filter(
    (o) => o.source === "hub" && o.leg === "DEPOT_TO_EB_GROUP" && o.status === "requested"
  ).length;

  const canCreate = caps.has("po.create");
  const canApprove = caps.has("po.approve");
  const canReceive = caps.has("po.receive");

  // Attach received totals per line (partial-delivery progress).
  const lineIds = all.flatMap((o) => (o.lines ?? []).map((l) => l.id));
  if (lineIds.length) {
    const { data: receipts } = await supabase
      .from("po_line_receipts")
      .select("po_line_id, qty_received")
      .in("po_line_id", lineIds);
    const recvByLine = new Map<string, number>();
    for (const r of receipts ?? []) recvByLine.set(r.po_line_id, (recvByLine.get(r.po_line_id) ?? 0) + r.qty_received);
    for (const o of all) for (const l of o.lines ?? []) l.qty_received = recvByLine.get(l.id) ?? 0;
  }

  // Attach files per PO.
  const poIds = all.map((o) => o.id);
  if (poIds.length) {
    const { data: atts } = await supabase
      .from("po_attachments")
      .select("id, po_id, storage_path, filename, content_type, size_bytes, uploaded_by_uid, created_at")
      .in("po_id", poIds)
      .order("created_at", { ascending: false });
    const byPo = new Map<string, PoAttachment[]>();
    for (const a of (atts ?? []) as PoAttachment[]) {
      const arr = byPo.get(a.po_id) ?? [];
      arr.push(a);
      byPo.set(a.po_id, arr);
    }
    for (const o of all) o.attachments = byPo.get(o.id) ?? [];
  }
  const canManageAttachments = canCreate || canApprove || canReceive;

  // Attach the auto-resolved Cargo Partner shipment per PO (SPOT ID + tracking).
  if (poIds.length) {
    const { data: shipRows } = await supabase.from("po_shipments").select("*").in("po_id", poIds);
    const shipByPo = new Map<string, PoShipment>();
    for (const sh of (shipRows ?? []) as PoShipment[]) shipByPo.set(sh.po_id, sh);
    for (const o of all) o.shipment = shipByPo.get(o.id) ?? null;
  }
  const canDetectShipment = caps.has("transport.view");

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
            Supplier & PO Tracker
          </h1>
          <p className="text-[#6b7280] text-sm mt-1">
            Intercompany purchase orders — Depots → EB Group → EB SRO
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canApprove && (
            <Link
              href="/purchase-orders/approvals"
              className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-[#e5e5e5] bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#2a2a2a] rounded-lg transition-colors"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              Approvals
              {pendingApproval > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-[#FF7026] rounded-full">
                  {pendingApproval}
                </span>
              )}
            </Link>
          )}
          {canCreate && (
            <Link
              href="/purchase-orders/create"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#FF7026] hover:bg-[#f2641b] text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Raise PO
            </Link>
          )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total Active", value: all.length, color: "text-white" },
          { label: "Awaiting Approval", value: pendingApproval, color: "text-blue-300" },
          { label: "In Manufacturing", value: all.filter((o) => o.status === "in_manufacturing").length, color: "text-purple-300" },
          { label: "Shipped", value: all.filter((o) => o.status === "shipped").length, color: "text-indigo-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
            <p className="text-[#6b7280] text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <PurchasingClient
        orders={all}
        canReceive={canReceive}
        canManageAttachments={canManageAttachments}
        canDetectShipment={canDetectShipment}
      />
    </div>
  );
}
