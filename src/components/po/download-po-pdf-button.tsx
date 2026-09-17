"use client";

// page-state: none (a busy flag that lives only as long as the download it guards)

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, FileDown } from "lucide-react";
import { downloadPoPdf, type PdfParty } from "@/lib/po-pdf";
import { downloadSupplierPoPdf } from "@/app/actions/purchase-orders/download-supplier-po";
import { entityPoCurrency, type FxRates } from "@/lib/po-currency";
import type { PurchaseOrder } from "@/lib/erp-types";

/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
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
  const [busy, setBusy] = useState(false);

  // Dean, 17 Sep 2026: "the PO that is from SRO to BAMIDA should have the format
  // that is currently in the Bill Of Materials Bamida PO." That document is
  // priced from the parent order's bill of materials, which only the server
  // holds, and it has no price-free variant, so anyone without cost.view keeps
  // the generic document rather than being refused a download.
  const supplierDocument = po.leg === "SRO_TO_SUPPLIER" && canViewCost;

  async function download() {
    if (!supplierDocument) {
      await downloadPoPdf(po, { canViewCost, parties, fx, rootCurrency });
      return;
    }
    const res = await downloadSupplierPoPdf({ poId: po.id });
    if (!res.ok) throw new Error(res.error);
    // The action returns bytes, not a link: the document is built per request
    // and never sits at an address somebody could guess.
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

  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          await download();
          toast.success("PO PDF downloaded");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not generate the PDF");
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
