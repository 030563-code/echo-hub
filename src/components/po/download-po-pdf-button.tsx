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

type Kind = "generic" | "specification" | "priced" | "shipping";

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
 * Dean, 17 Sep 2026: "the SRO PO on the kanban board appears as EBSR8XXX ...
 * Then when you click on that PO it is split up into manufacturing PO, priced
 * PO, Shipping PO. Shipping PO will be greyed out until the manufacturing is
 * finished."
 *
 * So one s.r.o. order, three documents:
 *   -1 Manufacturing  what the factory builds from. No figures on it at all, so
 *                     anyone who can see the order can print it.
 *   -3 Priced         the accounting document. cost.view only.
 *   -2 Shipping       the transport order. Its content is the shipment request,
 *                     which is drafted when the barriers are finished, so before
 *                     then there is nothing to print and the button says why.
 *                     It BOOKS NOTHING; printing is not sending.
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
  const [busy, setBusy] = useState<null | Kind>(null);
  const isSupplierOrder = po.leg === "SRO_TO_SUPPLIER";
  // The shipment request is drafted the moment the barriers exist, which is the
  // finished stamp. Before it there is no transport order to print.
  const shippingReady = Boolean(po.manufacturing?.finished_at);

  async function run(kind: Kind) {
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

  const face = (kind: Kind, label: string) => (
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
        {face("specification", "Manufacturing PO (PDF)")}
      </button>
      {canViewCost && (
        <button onClick={() => run("priced")} disabled={busy !== null} className={secondary}>
          {face("priced", "Priced PO (PDF)")}
        </button>
      )}
      <button
        onClick={() => run("shipping")}
        disabled={busy !== null || !shippingReady}
        title={shippingReady ? undefined : "Available once manufacturing is finished"}
        className={secondary}
      >
        {face("shipping", "Shipping PO (PDF)")}
      </button>
      {!shippingReady && (
        <p className="text-xs text-gray-500">The shipping order appears once manufacturing is finished.</p>
      )}
    </div>
  );
}
