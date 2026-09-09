"use client";

// page-state: none (dialog-scoped, the quantities are typed and logged in one sitting)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { X, Loader2 } from "lucide-react";
import { recordReceipt } from "@/app/actions/purchase-orders/receive-po";
import { chainNumber } from "@/lib/po-number";
import type { PurchaseOrder } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
export default function ReceiveModal({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
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
              Log delivery: <span className="font-mono text-echo-orange">{chainNumber(po)}</span>
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
