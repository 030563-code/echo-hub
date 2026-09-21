"use client";

// page-state: none (dialog-scoped: one depot and one note, chosen and sent in one sitting)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { X, Loader2, PackageCheck } from "lucide-react";
import { markArrivedAtDepot } from "@/app/actions/purchase-orders/arrive-at-depot";
import { ARRIVAL_DEPOTS } from "@/lib/stock/warehouses";
import { depotLabel } from "@/lib/depot-constants";
import { chainNumber } from "@/lib/po-number";
import type { PurchaseOrder } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

/**
 * The container is here: pick the depot and the barriers move from s.r.o. to
 * that shelf. Shared by the board drawer and the single order page.
 */
export default function ArrivalDialog({
  po,
  defaultDepot,
  onClose,
}: {
  po: PurchaseOrder;
  defaultDepot: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [depot, setDepot] = useState<string>(
    defaultDepot && (ARRIVAL_DEPOTS as readonly string[]).includes(defaultDepot) ? defaultDepot : ARRIVAL_DEPOTS[0],
  );
  const [note, setNote] = useState("");
  const units = (po.lines ?? []).reduce((a, l) => a + (l.quantity ?? 0), 0);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await markArrivedAtDepot({
        poId: po.id,
        depot: depot as (typeof ARRIVAL_DEPOTS)[number],
        note: note.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      const left =
        res.leftSro.applied > 0
          ? `${res.units} units moved from s.r.o. to ${depotLabel(res.depot)}`
          : `${res.units} units received at ${depotLabel(res.depot)} (s.r.o. was already deducted when the shipment was booked)`;
      toast.success(left);
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900">Arrived at depot</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-gray-600">
                {chainNumber(po)}: {units} units leave s.r.o. and land on the depot you choose. If the shipment was
                booked through Cargo Partner, s.r.o. was already deducted and only the depot changes.
              </Dialog.Description>
            </div>
            <Dialog.Close className="text-gray-400 hover:text-gray-700" aria-label="Close">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <label className="mt-4 block text-xs font-medium text-gray-700">
            Depot of arrival
            <select value={depot} onChange={(e) => setDepot(e.target.value)} className={`${inputCls} mt-1`}>
              {ARRIVAL_DEPOTS.map((d) => (
                <option key={d} value={d}>
                  {depotLabel(d)} ({d})
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block text-xs font-medium text-gray-700">
            Note (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Container number, damage, anything the ledger should remember"
              className={`${inputCls} mt-1`}
              maxLength={500}
            />
          </label>

          {error && <p className="mt-3 text-xs text-red-700">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={pending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-echo-orange hover:bg-echo-orange-hover rounded-lg disabled:opacity-50"
            >
              {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PackageCheck className="w-3.5 h-3.5" />}
              Confirm arrival
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
