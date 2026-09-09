"use client";

// page-state: none (a busy flag that lives only as long as the download it guards)

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, FileDown } from "lucide-react";
import { downloadPoPdf, type PdfParty } from "@/lib/po-pdf";
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
