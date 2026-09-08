"use client";

import { useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { LayoutGrid, List, X, PackageCheck, Loader2, Check, Paperclip, Download, Upload, Trash2, Ship, Inbox, FileDown, ArrowRight } from "lucide-react";
import KanbanBoard from "@/components/board/KanbanBoard";
import BoardTable from "@/components/board/BoardTable";
import StatusBadge from "@/components/board/StatusBadge";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchBox } from "@/components/ui/search-box";
import { cn, formatRelative } from "@/lib/utils";
import { recordReceipt } from "@/app/actions/purchase-orders/receive-po";
import { uploadPoAttachment, getPoAttachmentUrl, deletePoAttachment } from "@/app/actions/purchase-orders/attachments";
import { resolvePoShipment, syncAllPoShipments } from "@/app/actions/purchase-orders/po-shipments";
import { raiseCargoPo } from "@/app/actions/purchase-orders/raise-cargo-po";
import { chainNumber, isFullyReceived, legLabel, displayPoNumber } from "@/lib/po-number";
import { downloadPoPdf, type PdfParty } from "@/lib/po-pdf";
import { entityPoCurrency, type FxRates } from "@/lib/po-currency";
import { stageLabel, type LifecycleStage } from "@/lib/po-lifecycle";
import { setPoStage } from "@/app/actions/purchase-orders/set-po-stage";
import type { PurchaseOrder } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";
import { usePersistedView } from "@/hooks/use-page-state";
import { parsePoBoardView, type PoBoardView } from "@/lib/page-drafts";

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

const TABLE_COLUMNS: ColumnDef<PurchaseOrder, unknown>[] = [
  {
    accessorKey: "po_number",
    header: "PO Number",
    cell: ({ getValue }) => (
      <span className="font-mono text-echo-orange text-xs font-medium">{displayPoNumber(getValue() as string)}</span>
    ),
  },
  {
    accessorKey: "from_entity",
    header: "From",
    cell: ({ getValue }) => <span className="text-gray-600 text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "to_entity",
    header: "To",
    cell: ({ getValue }) => <span className="text-gray-600 text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "leg",
    header: "Leg",
    cell: ({ getValue }) => (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
        {legLabel(getValue() as string)}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
  },
  {
    accessorKey: "fulfilment_type",
    header: "Fulfilment",
    cell: ({ getValue }) => <StatusBadge status={getValue() as string | null} />,
  },
  {
    id: "skus",
    header: "SKUs",
    accessorFn: (row) => row.lines?.map((l) => l.sku).join(", ") ?? "",
    cell: ({ getValue }) => (
      <span className="text-xs text-gray-500 font-mono max-w-[200px] truncate block">
        {(getValue() as string) || "—"}
      </span>
    ),
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ getValue }) => (
      <span className="text-xs text-gray-500">{formatRelative(getValue() as string)}</span>
    ),
  },
];

interface Props {
  orders: PurchaseOrder[];
  canReceive: boolean;
  canManageAttachments: boolean;
  canDetectShipment: boolean;
  canViewCost: boolean;
  /** Can drag PO cards between lifecycle columns (po.approve / po.receive). */
  canMoveStage: boolean;
  /** From/To party addresses + weekly FX for the branded PO PDF (server-built). */
  parties: Record<string, PdfParty>;
  fx: FxRates | null;
}

export default function PurchasingClient({ orders, canReceive, canManageAttachments, canDetectShipment, canViewCost, canMoveStage, parties, fx }: Props) {
  const router = useRouter();
  // Kanban or table, and the search box, both remembered. The OPEN CARD is
  // not: a PO can be approved or cancelled while somebody is away, and
  // re-opening a drawer onto a row that has moved on is worse than opening
  // none.
  const [boardView, setBoardView] = usePersistedView<PoBoardView>(
    "po-board",
    { v: 1, view: "kanban", q: "" },
    parsePoBoardView,
  );
  const view = boardView.view;
  const setView = (next: "kanban" | "table") => setBoardView({ ...boardView, view: next });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);
  const [syncing, startSync] = useTransition();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const q = boardView.q;
  const setQ = (next: string) => setBoardView({ ...boardView, q: next });

  // Optimistic lifecycle-stage moves — the dragged card jumps columns instantly,
  // then the server persists + router.refresh() reconciles (useOptimistic reverts
  // to the fresh base once the transition settles, so there is no flicker).
  const [optimisticOrders, applyMove] = useOptimistic(
    orders,
    (state: PurchaseOrder[], move: { poId: string; stage: LifecycleStage }) =>
      state.map((o) => (o.id === move.poId ? { ...o, lifecycle_stage: move.stage } : o))
  );
  const [, startMove] = useTransition();

  function moveCard(poId: string, stage: LifecycleStage) {
    startMove(async () => {
      applyMove({ poId, stage });
      const res = await setPoStage({ poId, stage });
      if (res.success) toast.success(`Moved to “${stageLabel(stage)}”`);
      else toast.error(res.error);
      router.refresh();
    });
  }

  const visibleOrders = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return optimisticOrders;
    return optimisticOrders.filter((o) =>
      [
        o.po_number,
        chainNumber(o),
        o.from_entity,
        o.to_entity,
        o.status,
        o.fulfilment_type,
        o.reference_po_number,
        legLabel(o.leg),
        (o.lines ?? []).map((l) => l.sku).join(" "),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s))
    );
  }, [optimisticOrders, q]);

  function syncShipments() {
    setSyncMsg(null);
    startSync(async () => {
      const res = await syncAllPoShipments();
      if (res.success) {
        const text = `Checked ${res.checked} PO(s) — ${res.resolved} shipment(s) linked.`;
        setSyncMsg(text);
        toast.success(text);
      } else {
        setSyncMsg(res.error);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  // Derive the open panel's PO from live orders so it stays current after a
  // router.refresh (e.g. logging a delivery / attaching a file) — no sync effect.
  const selected = selectedId ? optimisticOrders.find((o) => o.id === selectedId) ?? null : null;

  // The cost is entered on the root (depot) leg in that depot's currency; the PDF
  // converts it into the leg's own currency. Resolve the chain root for the rate.
  const rootCurrencyFor = (po: PurchaseOrder) => {
    const root = optimisticOrders.find((o) => o.master_ref === po.master_ref && !o.parent_po_id) ?? po;
    return entityPoCurrency(root.from_entity);
  };

  return (
    <div className="relative">
      {/* View toggle */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center bg-gray-100 border border-gray-200 rounded-lg p-0.5">
          {(["kanban", "table"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2.5 sm:py-1.5 rounded-md text-xs font-medium transition-colors",
                view === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              )}
            >
              {v === "kanban" ? <LayoutGrid className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
              {v === "kanban" ? "Kanban" : "Table"}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">{visibleOrders.length} orders</span>
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search PO, entity, status…"
          className="ml-auto"
        />
        {canDetectShipment && (
          <button
            onClick={syncShipments}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
            title="Auto-detect each PO's Cargo Partner SPOT ID + shipment from its PO number"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
            Sync shipments
          </button>
        )}
        {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
      </div>

      {/* Board */}
      {visibleOrders.length === 0 ? (
        orders.length === 0 ? (
          <EmptyState
            icon={<Inbox className="w-8 h-8" />}
            title="No purchase orders yet"
            description="Raise a PO to start the Depot → Group → SRO approval chain. It'll appear here once created."
            action={
              <Link
                href="/purchase-orders/create"
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg transition-colors"
              >
                Raise a PO
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={<Inbox className="w-8 h-8" />}
            title="No matching purchase orders"
            description="Nothing matches your search. Try a different PO number, entity, status or SKU."
          />
        )
      ) : view === "kanban" ? (
        <KanbanBoard
          orders={visibleOrders}
          onCardClick={(o) => setSelectedId(o.id)}
          canMove={canMoveStage}
          onMove={moveCard}
        />
      ) : (
        <BoardTable
          stateKey="po-board:table"
          data={visibleOrders}
          columns={TABLE_COLUMNS}
          searchPlaceholder="Search PO number, entity, SKU..."
          onRowClick={(o) => setSelectedId(o.id)}
          emptyMessage="No purchase orders found"
        />
      )}

      {/* Side panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 w-full max-w-md sm:w-96 bg-white border-l border-gray-200 z-50 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <div>
              <p className="font-mono text-echo-orange font-medium">{displayPoNumber(selected.po_number)}</p>
              {selected.reference_po_number && (
                <p className="text-xs text-gray-400">Ref: {displayPoNumber(selected.reference_po_number)}</p>
              )}
            </div>
            <button
              onClick={() => setSelectedId(null)}
              className="p-2.5 sm:p-1.5 hover:bg-gray-100 rounded-lg transition-colors text-gray-500 hover:text-gray-900"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <DownloadPoPdfButton po={selected} canViewCost={canViewCost} parties={parties} fx={fx} rootCurrency={rootCurrencyFor(selected)} />

            <DetailSection label="Status">
              <StatusBadge status={selected.status} />
            </DetailSection>

            {/* Where the decisions live: choose stock or manufacture on an
                approved SRO leg, send a manufacturing order to Bamida. Reachable
                from the board as well as from the email. */}
            {(selected.leg === "EB_GROUP_TO_SRO" || selected.leg === "SRO_TO_SUPPLIER") && (
              <Link
                href={`/purchase-orders/${selected.id}`}
                className="flex items-center justify-between gap-2 w-full px-4 py-2.5 text-sm text-gray-900 bg-white hover:bg-gray-100 border border-gray-300 rounded-lg transition-colors"
              >
                {selected.leg === "EB_GROUP_TO_SRO" && selected.status === "approved"
                  ? "Choose how this is fulfilled"
                  : selected.leg === "SRO_TO_SUPPLIER"
                    ? "Manufacturing"
                    : "Open this order"}
                <ArrowRight className="w-3.5 h-3.5 text-gray-500" />
              </Link>
            )}

            <DetailSection label="Route">
              <p className="text-sm text-gray-900">{selected.from_entity}</p>
              <p className="text-xs text-gray-400">↓ {legLabel(selected.leg)}</p>
              <p className="text-sm text-gray-900">{selected.to_entity}</p>
            </DetailSection>

            {selected.reference_po_number && (
              <DetailSection label="Reference PO">
                <p className="text-sm font-mono text-gray-600">{selected.reference_po_number}</p>
              </DetailSection>
            )}

            {selected.fulfilment_type && (
              <DetailSection label="Fulfilment Type">
                <StatusBadge status={selected.fulfilment_type} />
              </DetailSection>
            )}

            {(selected.lines ?? []).length > 0 && (
              <DetailSection label="Line Items & Deliveries">
                <div className="space-y-2">
                  {(selected.lines ?? []).map((line) => {
                    const received = line.qty_received ?? 0;
                    const complete = received >= line.quantity;
                    return (
                      <div key={line.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                        <div>
                          <p className="text-xs font-mono text-gray-900">
                            {line.sku}{line.sku_suffix ? `-${line.sku_suffix}` : ""}
                          </p>
                          {line.product_name && (
                            <p className="text-[10px] text-gray-400">{line.product_name}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-gray-900 font-medium">×{line.quantity}</p>
                          {received > 0 && (
                            <p className={"text-[10px] " + (complete ? "text-green-700" : "text-amber-700")}>
                              {received}/{line.quantity} received
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Physical goods land at the DEPOT that ordered them, so the depot
                    leg is the single receiving point — the Group→SRO legs are
                    intercompany paperwork, not physical receipts. */}
                {canReceive && selected.source === "hub" && selected.status === "approved" && selected.leg === "DEPOT_TO_EB_GROUP" && !isFullyReceived(selected.lines ?? []) && (
                  <button
                    onClick={() => setReceiveTarget(selected)}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-echo-orange hover:bg-echo-orange-hover rounded-lg transition-colors"
                  >
                    <PackageCheck className="w-3.5 h-3.5" /> Log delivery
                  </button>
                )}
                {selected.source === "hub" && selected.status === "approved" && selected.leg !== "DEPOT_TO_EB_GROUP" && (
                  <p className="mt-2 text-[10px] text-gray-400">Intercompany leg — goods are received against the depot order.</p>
                )}
                {selected.status === "delivered" && (
                  <p className="mt-2 inline-flex items-center gap-1 text-[10px] text-green-700">
                    <Check className="w-3 h-3" /> Fully received
                  </p>
                )}
              </DetailSection>
            )}

            <DetailSection label="Timeline">
              <TimelineItem label="Created" date={selected.created_at} />
              {selected.approved_at && <TimelineItem label="Approved" date={selected.approved_at} by={selected.approved_by} />}
              {selected.decided_at && <TimelineItem label="SRO Decision" date={selected.decided_at} by={selected.decided_by} />}
              {selected.shipped_at && <TimelineItem label="Shipped" date={selected.shipped_at} />}
              {selected.delivered_at && <TimelineItem label="Delivered" date={selected.delivered_at} />}
            </DetailSection>

            {canDetectShipment && selected.leg === "EB_GROUP_TO_SRO" && <CargoPoButton po={selected} />}

            <ShipmentSection po={selected} canDetect={canDetectShipment} />

            {selected.notes && (
              <DetailSection label="Notes">
                <p className="text-sm text-gray-600">{selected.notes}</p>
              </DetailSection>
            )}

            <AttachmentsSection po={selected} canManage={canManageAttachments} />
          </div>
        </div>
      )}

      {receiveTarget && <ReceiveModal po={receiveTarget} onClose={() => setReceiveTarget(null)} />}
    </div>
  );
}

function DownloadPoPdfButton({
  po,
  canViewCost,
  parties,
  fx,
  rootCurrency,
}: {
  po: PurchaseOrder;
  canViewCost: boolean;
  parties: Record<string, PdfParty>;
  fx: FxRates | null;
  rootCurrency: ReturnType<typeof entityPoCurrency>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          await downloadPoPdf(po, { canViewCost, parties, fx, rootCurrency });
          toast.success("PO PDF downloaded");
        } catch {
          toast.error("Could not generate the PDF");
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white bg-[#025945] hover:bg-[#03674f] disabled:opacity-60 rounded-lg transition-colors"
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Download PDF
    </button>
  );
}

function CargoPoButton({ po }: { po: PurchaseOrder }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function raise() {
    setErr(null);
    setMsg(null);
    startTransition(async () => {
      const res = await raiseCargoPo({ sro_po_id: po.id });
      if (!res.ok) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        setMsg(`Cargo PO raised — ${res.chain} (${res.po_number}).`);
        toast.success(`Cargo PO raised — ${res.chain}`);
        router.refresh();
      }
    });
  }

  return (
    <div className="border-t border-gray-100 pt-4">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Cargo / Transport PO</p>
      <button
        onClick={raise}
        disabled={pending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
        Raise cargo PO ({chainNumber(po)}-2)
      </button>
      {msg && <p className="text-[10px] text-green-700 mt-2">{msg}</p>}
      {err && <p className="text-[10px] text-amber-700 mt-2">{err}</p>}
    </div>
  );
}

function ReceiveModal({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [batchRef, setBatchRef] = useState("");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});

  const lines = (po.lines ?? []).map((l) => ({
    id: l.id,
    sku: l.sku,
    ordered: l.quantity,
    received: l.qty_received ?? 0,
    remaining: l.quantity - (l.qty_received ?? 0),
  }));

  function submit() {
    setError(null);
    const payload = lines
      .map((l) => ({ lineId: l.id, qty: Number(qty[l.id]) || 0 }))
      .filter((l) => l.qty > 0);
    if (!payload.length) {
      setError("Enter a received quantity on at least one line.");
      return;
    }
    const over = payload.find((p) => {
      const l = lines.find((x) => x.id === p.lineId)!;
      return p.qty > l.remaining;
    });
    if (over) {
      const l = lines.find((x) => x.id === over.lineId)!;
      setError(`${l.sku}: receiving ${over.qty} exceeds the ${l.remaining} outstanding.`);
      return;
    }
    startTransition(async () => {
      const res = await recordReceipt({
        poId: po.id,
        batchRef: batchRef.trim() || undefined,
        note: note.trim() || undefined,
        lines: payload,
      });
      if (!res.success) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      toast.success(`Delivery logged for ${chainNumber(po)}`);
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white border border-gray-200 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Log delivery — <span className="font-mono text-echo-orange">{chainNumber(po)}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-gray-400 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-gray-500 mb-4">Enter quantities received in this batch. The PO closes once every line is fully received.</p>

          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 bg-gray-50 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-gray-900">{l.sku}</p>
                  <p className="text-[10px] text-gray-400">{l.received}/{l.ordered} received · {l.remaining} outstanding</p>
                </div>
                <input
                  value={qty[l.id] ?? ""}
                  onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`receive-${l.sku}`}
                  disabled={l.remaining <= 0}
                  className="w-24 px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm text-right tabular-nums text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange disabled:opacity-40"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-3">
            <input value={batchRef} onChange={(e) => setBatchRef(e.target.value)} placeholder="Batch / delivery ref (optional)" className={inputCls} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} />
          </div>

          {error && (
            <p className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{error}</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
              Cancel
            </Dialog.Close>
            <button
              onClick={submit}
              disabled={pending}
              className="inline-flex items-center gap-2 px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Log delivery
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShipmentSection({ po, canDetect }: { po: PurchaseOrder; canDetect: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const s = po.shipment;

  function detect() {
    setMsg(null);
    startTransition(async () => {
      const res = await resolvePoShipment(po.id);
      if (!res.success) {
        setMsg(res.error);
        toast.error(res.error);
      } else if (!res.found) {
        setMsg("No Cargo Partner shipment found for this PO number yet.");
      } else {
        toast.success("Shipment linked from Cargo Partner");
      }
      router.refresh();
    });
  }

  return (
    <DetailSection label="Shipment (Cargo Partner)">
      {s ? (
        <div className="space-y-0.5">
          <p className="text-xs">
            <span className="text-gray-400">SPOT ID</span> <span className="font-mono text-echo-orange">{s.spot_id}</span>
          </p>
          {s.container_ref && (
            <p className="text-xs text-gray-600">Container <span className="font-mono">{s.container_ref}</span></p>
          )}
          {s.vessel && <p className="text-xs text-gray-600">Vessel {s.vessel}{s.carrier ? ` · ${s.carrier}` : ""}</p>}
          {s.eta && <p className="text-xs text-gray-600">ETA {s.eta}</p>}
          {s.last_event && (
            <p className="text-[10px] text-gray-500">Last: {s.last_event}{s.last_event_at ? ` · ${s.last_event_at}` : ""}</p>
          )}
          {(s.match_count ?? 1) > 1 && (
            <p className="text-[10px] text-amber-700">{s.match_count} shipments matched this PO — first shown.</p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-gray-400">No shipment linked yet.</p>
      )}
      {canDetect && (
        <button
          onClick={detect}
          disabled={pending}
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
        >
          {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
          {s ? "Refresh shipment" : "Detect shipment"}
        </button>
      )}
      {msg && <p className="text-[10px] text-amber-700 mt-1">{msg}</p>}
    </DetailSection>
  );
}

function AttachmentsSection({ po, canManage }: { po: PurchaseOrder; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const atts = po.attachments ?? [];

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    const fd = new FormData();
    fd.append("poId", po.id);
    fd.append("file", file);
    startTransition(async () => {
      const res = await uploadPoAttachment(fd);
      if (!res.success) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success(`${file.name} attached`);
      }
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  }

  async function download(id: string) {
    setErr(null);
    const res = await getPoAttachmentUrl(id);
    if (res.success) window.open(res.url, "_blank");
    else {
      setErr(res.error);
      toast.error(res.error);
    }
  }

  function remove(id: string) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr(null);
    startTransition(async () => {
      const res = await deletePoAttachment(id);
      if (!res.success) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success("Attachment deleted");
      }
      router.refresh();
    });
  }

  return (
    <DetailSection label="Attachments">
      <div className="space-y-1.5">
        {atts.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2">
            <button onClick={() => download(a.id)} className="flex items-center gap-2 min-w-0 text-left hover:opacity-80">
              <Paperclip className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
              <span className="text-xs text-gray-900 truncate">{a.filename}</span>
            </button>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => download(a.id)} className="text-gray-500 hover:text-echo-orange transition-colors" title="Download">
                <Download className="w-3.5 h-3.5" />
              </button>
              {canManage && (
                <button onClick={() => remove(a.id)} className="text-gray-500 hover:text-red-700 transition-colors" title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {atts.length === 0 && <p className="text-[10px] text-gray-400">No files attached.</p>}
      </div>
      {canManage && (
        <>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={onPick}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
          >
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Attach file
          </button>
        </>
      )}
      {err && <p className="text-red-700 text-xs mt-2">{err}</p>}
    </DetailSection>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-1.5">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function TimelineItem({ label, date, by }: { label: string; date: string; by?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="w-1.5 h-1.5 rounded-full bg-echo-orange mt-1 flex-shrink-0" />
      <div>
        <span className="text-gray-600">{label}</span>
        <span className="text-gray-400 ml-1">{formatRelative(date)}</span>
        {by && <span className="text-gray-400 ml-1">by {by}</span>}
      </div>
    </div>
  );
}
