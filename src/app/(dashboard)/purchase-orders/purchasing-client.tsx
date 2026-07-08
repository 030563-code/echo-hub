"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { LayoutGrid, List, X, PackageCheck, Loader2, Check, Paperclip, Download, Upload, Trash2, Ship } from "lucide-react";
import KanbanBoard from "@/components/board/KanbanBoard";
import BoardTable from "@/components/board/BoardTable";
import StatusBadge from "@/components/board/StatusBadge";
import { cn, formatRelative } from "@/lib/utils";
import { recordReceipt } from "@/app/actions/purchase-orders/receive-po";
import { uploadPoAttachment, getPoAttachmentUrl, deletePoAttachment } from "@/app/actions/purchase-orders/attachments";
import { resolvePoShipment, syncAllPoShipments } from "@/app/actions/purchase-orders/po-shipments";
import { raiseCargoPo } from "@/app/actions/purchase-orders/raise-cargo-po";
import { chainNumber, isFullyReceived, legLabel } from "@/lib/po-number";
import type { PurchaseOrder } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";

const TABLE_COLUMNS: ColumnDef<PurchaseOrder, unknown>[] = [
  {
    accessorKey: "po_number",
    header: "PO Number",
    cell: ({ getValue }) => (
      <span className="font-mono text-[#FF7026] text-xs font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "from_entity",
    header: "From",
    cell: ({ getValue }) => <span className="text-[#9ca3af] text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "to_entity",
    header: "To",
    cell: ({ getValue }) => <span className="text-[#9ca3af] text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "leg",
    header: "Leg",
    cell: ({ getValue }) => (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#6b7280]">
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
      <span className="text-xs text-[#6b7280] font-mono max-w-[200px] truncate block">
        {(getValue() as string) || "—"}
      </span>
    ),
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ getValue }) => (
      <span className="text-xs text-[#6b7280]">{formatRelative(getValue() as string)}</span>
    ),
  },
];

interface Props {
  orders: PurchaseOrder[];
  canReceive: boolean;
  canManageAttachments: boolean;
  canDetectShipment: boolean;
}

export default function PurchasingClient({ orders, canReceive, canManageAttachments, canDetectShipment }: Props) {
  const router = useRouter();
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);
  const [syncing, startSync] = useTransition();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function syncShipments() {
    setSyncMsg(null);
    startSync(async () => {
      const res = await syncAllPoShipments();
      setSyncMsg(res.success ? `Checked ${res.checked} PO(s) — ${res.resolved} shipment(s) linked.` : res.error);
      router.refresh();
    });
  }

  // Derive the open panel's PO from live `orders` so it stays current after a
  // router.refresh (e.g. logging a delivery / attaching a file) — no sync effect.
  const selected = selectedId ? orders.find((o) => o.id === selectedId) ?? null : null;

  return (
    <div className="relative">
      {/* View toggle */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-0.5">
          {(["kanban", "table"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                view === v ? "bg-[#2a2a2a] text-[#e5e5e5]" : "text-[#6b7280] hover:text-[#9ca3af]"
              )}
            >
              {v === "kanban" ? <LayoutGrid className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
              {v === "kanban" ? "Kanban" : "Table"}
            </button>
          ))}
        </div>
        <span className="text-xs text-[#4b5563]">{orders.length} orders</span>
        {canDetectShipment && (
          <button
            onClick={syncShipments}
            disabled={syncing}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
            title="Auto-detect each PO's Cargo Partner SPOT ID + shipment from its PO number"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
            Sync shipments
          </button>
        )}
        {syncMsg && <span className="text-xs text-[#6b7280]">{syncMsg}</span>}
      </div>

      {/* Board */}
      {view === "kanban" ? (
        <KanbanBoard orders={orders} onCardClick={(o) => setSelectedId(o.id)} />
      ) : (
        <BoardTable
          data={orders}
          columns={TABLE_COLUMNS}
          searchPlaceholder="Search PO number, entity, SKU..."
          onRowClick={(o) => setSelectedId(o.id)}
          emptyMessage="No purchase orders found"
        />
      )}

      {/* Side panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 w-96 bg-[#161616] border-l border-[#2a2a2a] z-50 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a2a]">
            <div>
              <p className="font-mono text-[#FF7026] font-medium">{chainNumber(selected)}</p>
              <p className="text-xs text-[#4b5563]">{selected.po_number}</p>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              className="p-1.5 hover:bg-[#2a2a2a] rounded-lg transition-colors text-[#6b7280] hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <DetailSection label="Status">
              <StatusBadge status={selected.status} />
            </DetailSection>

            <DetailSection label="Route">
              <p className="text-sm text-[#e5e5e5]">{selected.from_entity}</p>
              <p className="text-xs text-[#4b5563]">↓ {legLabel(selected.leg)}</p>
              <p className="text-sm text-[#e5e5e5]">{selected.to_entity}</p>
            </DetailSection>

            {selected.reference_po_number && (
              <DetailSection label="Reference PO">
                <p className="text-sm font-mono text-[#9ca3af]">{selected.reference_po_number}</p>
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
                      <div key={line.id} className="flex items-center justify-between bg-[#1e1e1e] rounded-lg px-3 py-2">
                        <div>
                          <p className="text-xs font-mono text-[#e5e5e5]">
                            {line.sku}{line.sku_suffix ? `-${line.sku_suffix}` : ""}
                          </p>
                          {line.product_name && (
                            <p className="text-[10px] text-[#4b5563]">{line.product_name}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-[#e5e5e5] font-medium">×{line.quantity}</p>
                          {received > 0 && (
                            <p className={"text-[10px] " + (complete ? "text-green-300" : "text-yellow-300")}>
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
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-[#FF7026] hover:bg-[#f2641b] rounded-lg transition-colors"
                  >
                    <PackageCheck className="w-3.5 h-3.5" /> Log delivery
                  </button>
                )}
                {selected.source === "hub" && selected.status === "approved" && selected.leg !== "DEPOT_TO_EB_GROUP" && (
                  <p className="mt-2 text-[10px] text-[#4b5563]">Intercompany leg — goods are received against the depot order.</p>
                )}
                {selected.status === "delivered" && (
                  <p className="mt-2 inline-flex items-center gap-1 text-[10px] text-green-300">
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
                <p className="text-sm text-[#9ca3af]">{selected.notes}</p>
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
      if (!res.ok) setErr(res.error);
      else {
        setMsg(`Cargo PO raised — ${res.chain} (${res.po_number}).`);
        router.refresh();
      }
    });
  }

  return (
    <div className="border-t border-[#222] pt-4">
      <p className="text-[10px] uppercase tracking-wider text-[#4b5563] mb-2">Cargo / Transport PO</p>
      <button
        onClick={raise}
        disabled={pending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
        Raise cargo PO ({chainNumber(po)}-2)
      </button>
      {msg && <p className="text-[10px] text-green-400 mt-2">{msg}</p>}
      {err && <p className="text-[10px] text-yellow-400 mt-2">{err}</p>}
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
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-full max-w-lg max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Log delivery — <span className="font-mono text-[#FF7026]">{chainNumber(po)}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-[#6b7280] mb-4">Enter quantities received in this batch. The PO closes once every line is fully received.</p>

          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 bg-[#1e1e1e] rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-[#e5e5e5]">{l.sku}</p>
                  <p className="text-[10px] text-[#4b5563]">{l.received}/{l.ordered} received · {l.remaining} outstanding</p>
                </div>
                <input
                  value={qty[l.id] ?? ""}
                  onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`receive-${l.sku}`}
                  disabled={l.remaining <= 0}
                  className="w-24 px-3 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-right tabular-nums text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] disabled:opacity-40"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-3">
            <input value={batchRef} onChange={(e) => setBatchRef(e.target.value)} placeholder="Batch / delivery ref (optional)" className={inputCls} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} />
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2 mt-3">{error}</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              Cancel
            </Dialog.Close>
            <button
              onClick={submit}
              disabled={pending}
              className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
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
      if (!res.success) setMsg(res.error);
      else if (!res.found) setMsg("No Cargo Partner shipment found for this PO number yet.");
      router.refresh();
    });
  }

  return (
    <DetailSection label="Shipment (Cargo Partner)">
      {s ? (
        <div className="space-y-0.5">
          <p className="text-xs">
            <span className="text-[#4b5563]">SPOT ID</span> <span className="font-mono text-[#FF7026]">{s.spot_id}</span>
          </p>
          {s.container_ref && (
            <p className="text-xs text-[#9ca3af]">Container <span className="font-mono">{s.container_ref}</span></p>
          )}
          {s.vessel && <p className="text-xs text-[#9ca3af]">Vessel {s.vessel}{s.carrier ? ` · ${s.carrier}` : ""}</p>}
          {s.eta && <p className="text-xs text-[#9ca3af]">ETA {s.eta}</p>}
          {s.last_event && (
            <p className="text-[10px] text-[#6b7280]">Last: {s.last_event}{s.last_event_at ? ` · ${s.last_event_at}` : ""}</p>
          )}
          {(s.match_count ?? 1) > 1 && (
            <p className="text-[10px] text-yellow-400">{s.match_count} shipments matched this PO — first shown.</p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-[#4b5563]">No shipment linked yet.</p>
      )}
      {canDetect && (
        <button
          onClick={detect}
          disabled={pending}
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
        >
          {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ship className="w-3.5 h-3.5" />}
          {s ? "Refresh shipment" : "Detect shipment"}
        </button>
      )}
      {msg && <p className="text-[10px] text-yellow-400 mt-1">{msg}</p>}
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
      if (!res.success) setErr(res.error);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  }

  async function download(id: string) {
    setErr(null);
    const res = await getPoAttachmentUrl(id);
    if (res.success) window.open(res.url, "_blank");
    else setErr(res.error);
  }

  function remove(id: string) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr(null);
    startTransition(async () => {
      const res = await deletePoAttachment(id);
      if (!res.success) setErr(res.error);
      router.refresh();
    });
  }

  return (
    <DetailSection label="Attachments">
      <div className="space-y-1.5">
        {atts.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 bg-[#1e1e1e] rounded-lg px-3 py-2">
            <button onClick={() => download(a.id)} className="flex items-center gap-2 min-w-0 text-left hover:opacity-80">
              <Paperclip className="w-3.5 h-3.5 text-[#6b7280] flex-shrink-0" />
              <span className="text-xs text-[#e5e5e5] truncate">{a.filename}</span>
            </button>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => download(a.id)} className="text-[#6b7280] hover:text-[#FF7026] transition-colors" title="Download">
                <Download className="w-3.5 h-3.5" />
              </button>
              {canManage && (
                <button onClick={() => remove(a.id)} className="text-[#6b7280] hover:text-red-400 transition-colors" title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {atts.length === 0 && <p className="text-[10px] text-[#4b5563]">No files attached.</p>}
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
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
          >
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Attach file
          </button>
        </>
      )}
      {err && <p className="text-red-400 text-xs mt-2">{err}</p>}
    </DetailSection>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-[#4b5563] font-medium mb-1.5">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function TimelineItem({ label, date, by }: { label: string; date: string; by?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="w-1.5 h-1.5 rounded-full bg-[#FF7026] mt-1 flex-shrink-0" />
      <div>
        <span className="text-[#9ca3af]">{label}</span>
        <span className="text-[#4b5563] ml-1">{formatRelative(date)}</span>
        {by && <span className="text-[#4b5563] ml-1">by {by}</span>}
      </div>
    </div>
  );
}
