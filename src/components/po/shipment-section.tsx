"use client";

// page-state: none (an in-flight flag and the one-line result of the detect that raised it)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Ship } from "lucide-react";
import { resolvePoShipment } from "@/app/actions/purchase-orders/po-shipments";
import DetailSection from "@/components/po/detail-section";
import type { PurchaseOrder } from "@/lib/erp-types";

/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
export default function ShipmentSection({ po, canDetect }: { po: PurchaseOrder; canDetect: boolean }) {
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
            <p className="text-[10px] text-amber-700">{s.match_count} shipments matched this PO, first shown.</p>
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
