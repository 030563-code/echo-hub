"use client";

// page-state: none (an in-flight flag and the one-line result of the click that raised it)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Ship } from "lucide-react";
import { raiseCargoPo } from "@/app/actions/purchase-orders/raise-cargo-po";
import { chainNumber } from "@/lib/po-number";
import type { PurchaseOrder } from "@/lib/erp-types";

/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
export default function CargoPoButton({ po }: { po: PurchaseOrder }) {
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
        setMsg(`Cargo PO raised: ${res.chain} (${res.po_number}).`);
        toast.success(`Cargo PO raised: ${res.chain}`);
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
