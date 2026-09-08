"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { X, FileDown } from "lucide-react";
import type { BamidaPo } from "@/lib/bamida-po";
import { buildBamidaPoPdf, bamidaPoPdfFilename } from "@/lib/bamida-po-pdf";

const eur = (v: number | null) =>
  v == null ? "—" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// `bamida` is built + cost-stripped SERVER-SIDE. When `priced` is false the costs
// are already absent (price-less "BOM PO" for users without cost.view).
export default function BamidaPoModal({ bamida, onClose }: { bamida: BamidaPo; onClose: () => void }) {
  const priced = bamida.priced;
  const docLabel = priced ? "Bamida PO" : "BOM PO";

  async function downloadPdf() {
    try {
      // The drawing itself lives in @/lib/bamida-po-pdf, because the same bytes
      // now also have to be emailed to Bamida from the server.
      const doc = await buildBamidaPoPdf(bamida);
      doc.save(bamidaPoPdfFilename(bamida));
      toast.success(`${docLabel} ${bamida.poNumber} downloaded`);
    } catch {
      toast.error("Couldn't generate the PDF, please try again.");
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              {docLabel} — <span className="font-mono text-[#FF7026]">{bamida.poNumber}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-[#6b7280] mb-4">
            Supplier {bamida.supplier.name} · {bamida.pallets} pallet{bamida.pallets === 1 ? "" : "s"} ·{" "}
            {priced
              ? "manufacturing + printing + packaging (materials supplied by SRO)."
              : "manufacturing + printing + packaging spec (prices hidden)."}
          </p>

          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                  <th className="text-left font-medium px-3 py-2">Code</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-right font-medium px-3 py-2">Qty</th>
                  {priced && <th className="text-right font-medium px-3 py-2">Price</th>}
                  {priced && <th className="text-right font-medium px-3 py-2">Amount</th>}
                  {priced && <th className="text-right font-medium px-3 py-2">Tax</th>}
                </tr>
              </thead>
              <tbody>
                {bamida.lines.map((l, i) => (
                  <tr key={i} className="border-t border-[#222]">
                    <td className="px-3 py-2 font-mono text-[#e5e5e5]">{l.code}</td>
                    <td className="px-3 py-2 text-[#9ca3af]">{l.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#9ca3af]">{l.qty}</td>
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-[#6b7280]">{eur(l.price)}</td>}
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-[#e5e5e5]">{eur(l.amount)}</td>}
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-[#6b7280]">{l.taxRate}%</td>}
                  </tr>
                ))}
                {bamida.lines.length === 0 && (
                  <tr>
                    <td colSpan={priced ? 6 : 3} className="px-3 py-6 text-center text-[#4b5563]">
                      No mapped BOM lines — check SKU → model mapping{priced ? " + master man/print costs." : "."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {priced ? (
            <div className="flex flex-col items-end gap-1 mt-3 text-sm">
              <span className="text-[#9ca3af]">Subtotal <span className="tabular-nums text-[#e5e5e5]">{eur(bamida.subtotal)}</span></span>
              <span className="text-[#9ca3af]">Tax <span className="tabular-nums text-[#e5e5e5]">{eur(bamida.tax)}</span></span>
              <span className="text-[#FF7026] font-bold">Total incl. tax <span className="tabular-nums">{eur(bamida.total)}</span></span>
            </div>
          ) : (
            <p className="text-[10px] text-[#4b5563] mt-3">Prices hidden — you don&apos;t have cost visibility (cost.view).</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              Close
            </Dialog.Close>
            <button
              onClick={downloadPdf}
              disabled={bamida.lines.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <FileDown className="w-4 h-4" /> Download PDF
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
