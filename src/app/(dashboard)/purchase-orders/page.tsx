import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, ClipboardCheck } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { activeOrganisation } from "@/lib/active-organisation.server";
import { chainFilter, chainsForOrg } from "@/lib/po-organisations";
import { NoOrganisationCard } from "@/components/organisations/no-organisation-card";
import { stripPurchaseOrderCosts } from "@/lib/price-visibility";
import { effectiveStage } from "@/lib/po-lifecycle";
import { getPoPdfData } from "@/lib/po-pdf-data";
import PurchasingClient from "./purchasing-client";
import type { PurchaseOrder, PoAttachment, PoShipment, PoManufacturing } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const supabase = await createServerClient();
  const auth = await getAuthorizedUser();
  if (!auth.ok) redirect("/");
  const caps = auth.capabilities;

  // The organisation being looked at decides which chains: the ones with a leg
  // naming the company or one of its depots, loaded whole. Found first, then
  // fetched, so the predicate is in the query and not in a filter over
  // everything.
  const org = await activeOrganisation(auth);
  if (!org) return <NoOrganisationCard title="Supplier & PO Tracker" what="purchase orders" />;
  const filter = chainFilter(await chainsForOrg(supabase, org));

  const { data: orders } =
    filter === null
      ? { data: [] as PurchaseOrder[] }
      : await supabase
          .from("purchase_orders")
          .select("*, lines:purchase_order_lines(*)")
          .or(filter)
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
  const canMoveStage = canApprove || canReceive;

  // Everything below depends only on the orders already loaded, and on nothing
  // else in this list, so it is fetched in ONE round of parallel requests rather
  // than five in a row. Rewritten 16 Sep 2026 while chasing page latency: with
  // the server next to the database each hop is small, but five small hops in
  // sequence were still five, and the PDF data never needed the orders at all.
  const lineIds = all.flatMap((o) => (o.lines ?? []).map((l) => l.id));
  const poIds = all.map((o) => o.id);
  const [receiptsRes, attsRes, shipRes, mfgRes, poPdfData] = await Promise.all([
    lineIds.length
      ? supabase.from("po_line_receipts").select("po_line_id, qty_received").in("po_line_id", lineIds)
      : Promise.resolve({ data: [] as Array<{ po_line_id: string; qty_received: number }> }),
    poIds.length
      ? supabase
          .from("po_attachments")
          .select("id, po_id, storage_path, filename, content_type, size_bytes, uploaded_by_uid, created_at")
          .in("po_id", poIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as PoAttachment[] }),
    poIds.length
      ? supabase.from("po_shipments").select("*").in("po_id", poIds)
      : Promise.resolve({ data: [] as PoShipment[] }),
    // Service-role client: po_manufacturing is not reachable by anon or
    // authenticated at all. Narrowed to the presentational columns.
    poIds.length
      ? createAdminClient()
          .from("po_manufacturing")
          .select("po_id, sent_at, sent_was_test, est_start, est_finish, finished_at")
          .in("po_id", poIds)
      : Promise.resolve({ data: [] as Array<{ po_id: string; sent_at: string | null; sent_was_test: boolean | null; est_start: string | null; est_finish: string | null; finished_at: string | null }> }),
    // From/To party addresses + weekly FX for the branded PO PDF.
    getPoPdfData(supabase),
  ]);

  // Received totals per line (partial-delivery progress).
  const recvByLine = new Map<string, number>();
  for (const r of receiptsRes.data ?? []) recvByLine.set(r.po_line_id, (recvByLine.get(r.po_line_id) ?? 0) + r.qty_received);
  for (const o of all) for (const l of o.lines ?? []) l.qty_received = recvByLine.get(l.id) ?? 0;

  // Files per PO.
  const byPo = new Map<string, PoAttachment[]>();
  for (const a of (attsRes.data ?? []) as PoAttachment[]) {
    const arr = byPo.get(a.po_id) ?? [];
    arr.push(a);
    byPo.set(a.po_id, arr);
  }
  for (const o of all) o.attachments = byPo.get(o.id) ?? [];
  const canManageAttachments = canCreate || canApprove || canReceive;

  // The auto-resolved Cargo Partner shipment per PO (SPOT ID + tracking).
  const shipByPo = new Map<string, PoShipment>();
  for (const sh of (shipRes.data ?? []) as PoShipment[]) shipByPo.set(sh.po_id, sh);
  for (const o of all) o.shipment = shipByPo.get(o.id) ?? null;
  const canDetectShipment = caps.has("transport.view");

  // Manufacturing progress per PO: sent, dates given, finished.
  const mfgByPo = new Map<string, PoManufacturing>();
  for (const m of mfgRes.data ?? []) {
    mfgByPo.set(String(m.po_id), {
      sent_at: m.sent_at ?? null,
      sent_was_test: m.sent_was_test === true,
      est_start: m.est_start ?? null,
      est_finish: m.est_finish ?? null,
      finished_at: m.finished_at ?? null,
    });
  }
  for (const o of all) o.manufacturing = mfgByPo.get(o.id) ?? null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
            Supplier & PO Tracker
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Intercompany purchase orders. Depots → EB Group → EB SRO
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canApprove && (
            <Link
              href="/purchase-orders/approvals"
              className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-900 bg-white hover:bg-gray-100 border border-gray-300 rounded-lg transition-colors"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              Approvals
              {pendingApproval > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-echo-orange rounded-full">
                  {pendingApproval}
                </span>
              )}
            </Link>
          )}
          {canCreate && (
            <Link
              href="/purchase-orders/create"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Raise PO
            </Link>
          )}
        </div>
      </div>

      {/* Stats strip */}
      {/* Five tiles since Ready for Shipment joined, so the row needs a fifth
          column at desktop width rather than wrapping one tile onto its own line. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {[
          { label: "Total Active", value: all.length, color: "text-gray-900" },
          { label: "Awaiting Approval", value: pendingApproval, color: "text-blue-800" },
          { label: "In Manufacturing", value: all.filter((o) => effectiveStage(o) === "manufacturing").length, color: "text-purple-800" },
          // Added 9 Sep with the stage itself. Without a tile of its own, every
          // order waiting on freight vanished from this strip: it had stopped
          // being counted as manufacturing and was not yet shipping.
          { label: "Ready for Shipment", value: all.filter((o) => effectiveStage(o) === "ready_for_shipment").length, color: "text-orange-800" },
          { label: "Shipping", value: all.filter((o) => effectiveStage(o) === "shipping").length, color: "text-indigo-800" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
            <p className="text-gray-500 text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <PurchasingClient
        orders={all}
        canReceive={canReceive}
        canManageAttachments={canManageAttachments}
        canDetectShipment={canDetectShipment}
        canViewCost={canViewCost}
        canMoveStage={canMoveStage}
        parties={poPdfData.parties}
        fx={poPdfData.fx}
      />
    </div>
  );
}
