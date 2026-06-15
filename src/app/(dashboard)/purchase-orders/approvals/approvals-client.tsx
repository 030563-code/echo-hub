"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, X, Loader2, Inbox, AlertTriangle } from "lucide-react";
import { formatRelative } from "@/lib/utils";
import { decidePurchaseOrder } from "@/app/actions/purchase-orders/decide-po";
import type { PurchaseOrder } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";

export default function ApprovalsClient({ orders }: { orders: PurchaseOrder[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "warn" | "error"; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PurchaseOrder | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  function approve(po: PurchaseOrder) {
    setNotice(null);
    setBusyId(po.id);
    startTransition(async () => {
      const res = await decidePurchaseOrder({ poId: po.id, decision: "approve" });
      setBusyId(null);
      if (!res.success) setNotice({ kind: "error", text: res.error });
      else if (res.warning) setNotice({ kind: "warn", text: res.warning });
      router.refresh();
    });
  }

  function confirmReject() {
    if (!rejectTarget) return;
    const po = rejectTarget;
    setNotice(null);
    setBusyId(po.id);
    startTransition(async () => {
      const res = await decidePurchaseOrder({
        poId: po.id,
        decision: "reject",
        note: rejectNote.trim() || undefined,
      });
      setBusyId(null);
      setRejectTarget(null);
      setRejectNote("");
      if (!res.success) setNotice({ kind: "error", text: res.error });
      router.refresh();
    });
  }

  if (orders.length === 0) {
    return (
      <div className="border border-dashed border-[#2a2a2a] rounded-xl p-16 text-center">
        <Inbox className="w-8 h-8 text-[#3a3a3a] mx-auto mb-3" />
        <p className="text-[#9ca3af] mb-1">Nothing awaiting approval</p>
        <p className="text-xs text-[#4b5563]">Branch-raised purchase orders will appear here for EB Group sign-off.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p
          className={
            "flex items-start gap-2 text-sm rounded-lg px-3 py-2 border " +
            (notice.kind === "error"
              ? "text-red-400 bg-red-900/20 border-red-800/30"
              : "text-yellow-300 bg-yellow-900/20 border-yellow-800/30")
          }
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {notice.text}
        </p>
      )}

      {orders.map((po) => {
        const busy = busyId === po.id;
        return (
          <div key={po.id} className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <p className="font-mono text-[#FF7026] font-medium">{po.po_number}</p>
                <p className="text-xs text-[#6b7280] mt-0.5">
                  <span className="font-mono">{po.from_entity}</span> → <span className="font-mono">{po.to_entity}</span>
                  <span className="text-[#4b5563]"> · raised {formatRelative(po.created_at)}</span>
                  {po.requested_by && <span className="text-[#4b5563]"> by {po.requested_by}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setRejectTarget(po)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/20 border border-red-900/40 rounded-lg transition-colors disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" />
                  Reject
                </button>
                <button
                  onClick={() => approve(po)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-green-700/80 hover:bg-green-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Approve
                </button>
              </div>
            </div>

            {/* Lines */}
            <div className="rounded-lg border border-[#222] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                    <th className="text-left font-medium px-3 py-1.5">Product</th>
                    <th className="text-right font-medium px-3 py-1.5">Qty</th>
                    <th className="text-left font-medium px-3 py-1.5">HS code</th>
                    <th className="text-right font-medium px-3 py-1.5">Unit price</th>
                  </tr>
                </thead>
                <tbody>
                  {(po.lines ?? []).map((l) => (
                    <tr key={l.id} className="border-t border-[#222]">
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[#e5e5e5]">{l.sku}</span>
                        {l.product_name && <span className="text-[#6b7280] text-xs"> — {l.product_name}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[#e5e5e5]">{l.quantity}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-[#9ca3af]">{l.hs_code ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[#9ca3af]">
                        {l.unit_price != null ? l.unit_price.toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(po.delivery_address || po.notes) && (
              <div className="mt-3 space-y-1">
                {po.delivery_address && (
                  <p className="text-xs text-[#6b7280]">
                    <span className="text-[#4b5563]">Deliver to:</span> {po.delivery_address}
                  </p>
                )}
                {po.notes && (
                  <p className="text-xs text-[#6b7280]">
                    <span className="text-[#4b5563]">Notes:</span> {po.notes}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Reject reason dialog */}
      <Dialog.Root open={rejectTarget !== null} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Reject {rejectTarget?.po_number}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-[#6b7280] mt-1 mb-4">
              This marks the PO rejected and does not send it to EB SRO. Add an optional reason.
            </Dialog.Description>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              placeholder="Reason (optional)…"
              className={inputCls + " resize-none"}
            />
            <div className="flex justify-end gap-2 mt-4">
              <Dialog.Close className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
                Cancel
              </Dialog.Close>
              <button
                onClick={confirmReject}
                disabled={busyId === rejectTarget?.id}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-700/80 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60"
              >
                {busyId === rejectTarget?.id && <Loader2 className="w-4 h-4 animate-spin" />}
                Reject PO
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
