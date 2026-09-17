"use client";

// page-state: none (a busy flag that lives only as long as the download it guards)

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, FileDown } from "lucide-react";
import { downloadPoPdf, type PdfParty } from "@/lib/po-pdf";
import {
  downloadSupplierPoPdf,
  type SupplierPoPdfResult,
} from "@/app/actions/purchase-orders/download-supplier-po";
import { entityPoCurrency, type FxRates } from "@/lib/po-currency";
import type { PurchaseOrder } from "@/lib/erp-types";

/** Hand the browser bytes the server built. The document is made per request and
 *  never sits at an address somebody could guess, so there is no link to give. */
function save(res: Extract<SupplierPoPdfResult, { ok: true }>) {
  const blob = new Blob([Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = res.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Shared by the purchase order board drawer and the single order page.
 *
 * A supplier order produces TWO documents and this offers both, because they go
 * to different people for different reasons (Dean, 17 Sep 2026):
 *   -1 Specification  what the factory builds from. No prices anywhere, so
 *                     anyone who can see the order can print it.
 *   -3 Priced order   the accounting document. cost.view only.
 * Every other leg keeps the one generic document it always had.
 */
export default function DownloadPoPdfButton({
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
  const [busy, setBusy] = useState<null | "generic" | "specification" | "priced">(null);
  const isSupplierOrder = po.leg === "SRO_TO_SUPPLIER";

  async function run(kind: "generic" | "specification" | "priced") {
    setBusy(kind);
    try {
      if (kind === "generic") {
        await downloadPoPdf(po, { canViewCost, parties, fx, rootCurrency });
      } else {
        const res = await downloadSupplierPoPdf({ poId: po.id, kind });
        if (!res.ok) throw new Error(res.error);
        save(res);
      }
      toast.success("PDF downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate the PDF");
    } finally {
      setBusy(null);
    }
  }

  const face = (kind: "generic" | "specification" | "priced", label: string) => (
    <>
      {busy === kind ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} {label}
    </>
  );
  const primary =
    "w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white bg-[#025945] hover:bg-[#03674f] disabled:opacity-60 rounded-lg transition-colors";
  const secondary =
    "w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-60 rounded-lg transition-colors";

  if (!isSupplierOrder) {
    return (
      <button onClick={() => run("generic")} disabled={busy !== null} className={primary}>
        {face("generic", "Download PDF")}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <button onClick={() => run("specification")} disabled={busy !== null} className={primary}>
        {face("specification", "Specification (PDF)")}
      </button>
      {canViewCost && (
        <button onClick={() => run("priced")} disabled={busy !== null} className={secondary}>
          {face("priced", "Priced order (PDF)")}
        </button>
      )}
    </div>
  );
}
