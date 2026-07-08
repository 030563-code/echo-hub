"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X, FileDown } from "lucide-react";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";

// `doc` is built + cost-stripped SERVER-SIDE. When `priced` is false the values
// are already absent (the viewer lacks cost.view).
export default function CommercialInvoiceModal({
  doc,
  warnings = [],
  onClose,
}: {
  doc: CommercialInvoiceDoc;
  warnings?: string[];
  onClose: () => void;
}) {
  const priced = doc.priced;
  const sym = doc.currency === "USD" ? "$" : "€";
  const money = (v: number | null) =>
    v == null ? "—" : `${sym}${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function downloadPdf() {
    const { default: jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const d = new jsPDF();
    const W = d.internal.pageSize.width;

    d.setFont("helvetica", "bold");
    d.setFontSize(16);
    d.text("COMMERCIAL INVOICE", W / 2, 16, { align: "center" });
    d.setFontSize(10);
    d.text(`${doc.invoice_number}   ·   ${doc.date}`, W / 2, 22, { align: "center" });

    d.setFontSize(9);
    d.setFont("helvetica", "bold");
    d.text("Seller", 14, 34);
    d.text("Buyer", W / 2 + 6, 34);
    d.setFont("helvetica", "normal");
    d.text([doc.seller.legal_name, ...doc.seller.address_lines, `VAT: ${doc.seller.vat_tax_id ?? "—"}`], 14, 39);
    d.text([doc.buyer.legal_name, ...doc.buyer.address_lines, `VAT: ${doc.buyer.vat_tax_id ?? "—"}`], W / 2 + 6, 39);

    const refLines = [
      `Container: ${doc.container_ref ?? "—"}`,
      `SPOT ID: ${doc.spot_id ?? "—"}`,
      `PO ref: ${doc.po_reference ?? "—"}`,
      `Currency: ${doc.currency}`,
    ];
    d.text(refLines, 14, 62);

    const head = priced
      ? [["Ln", "SKU", "Description", "Qty", "Unit value", "Line total", "HS code"]]
      : [["Ln", "SKU", "Description", "Qty", "HS code"]];
    const body = doc.lines.map((l, i) => {
      const base = [String(i + 1), l.sku, l.product_name, String(l.qty)];
      return priced
        ? [...base, (l.unit_value ?? 0).toFixed(2), (l.line_total ?? 0).toLocaleString("en-GB", { minimumFractionDigits: 2 }), l.hs_code ?? "—"]
        : [...base, l.hs_code ?? "—"];
    });

    autoTable(d, {
      startY: 86,
      head,
      body,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [40, 40, 40] },
      columnStyles: priced ? { 4: { halign: "right" }, 5: { halign: "right" } } : {},
    });

    const finalY = (d as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 100;
    let y = finalY + 8;
    if (priced) {
      d.setFontSize(9);
      d.setFont("helvetica", "normal");
      d.text(`SUBTOTAL (${doc.currency})   ${(doc.subtotal ?? 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
      y += 6;
      d.text(`TAX (${doc.currency})   ${(doc.tax_total ?? 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
      y += 7;
      d.setFont("helvetica", "bold");
      d.text(`TOTAL (${doc.currency})   ${(doc.total ?? 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
      y += 9;
      if (doc.fx) {
        d.setFont("helvetica", "normal");
        d.setFontSize(8);
        d.text(`FX ${doc.fx.pair} @ ${doc.fx.rate} (${doc.fx.method}${doc.fx.week_start ? `, w/c ${doc.fx.week_start}` : ""})`, W - 14, y, { align: "right" });
        y += 8;
      }
    }
    d.setFont("helvetica", "italic");
    d.setFontSize(7.5);
    d.text("Intercompany commercial invoice. Goods of EU origin unless stated. Value for customs purposes only.", 14, y + 2);

    d.save(`${doc.invoice_number}.pdf`);
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Commercial Invoice — <span className="font-mono text-[#FF7026]">{doc.invoice_number}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-[#6b7280] mb-3">
            {doc.seller.legal_name} → {doc.buyer.legal_name} · container{" "}
            <span className="font-mono text-[#9ca3af]">{doc.container_ref ?? "—"}</span> · {doc.currency}
          </p>

          {warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-yellow-400 mb-2">⚠ {w}</p>
          ))}

          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                  <th className="text-left font-medium px-3 py-2">SKU</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-right font-medium px-3 py-2">Qty</th>
                  {priced && <th className="text-right font-medium px-3 py-2">Unit value</th>}
                  {priced && <th className="text-right font-medium px-3 py-2">Line total</th>}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l, i) => (
                  <tr key={i} className="border-t border-[#222]">
                    <td className="px-3 py-2 font-mono text-[#e5e5e5]">{l.sku}</td>
                    <td className="px-3 py-2 text-[#9ca3af]">{l.product_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#9ca3af]">{l.qty}</td>
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-[#6b7280]">{money(l.unit_value)}</td>}
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-[#e5e5e5]">{money(l.line_total)}</td>}
                  </tr>
                ))}
                {doc.lines.length === 0 && (
                  <tr>
                    <td colSpan={priced ? 5 : 3} className="px-3 py-6 text-center text-[#4b5563]">No lines.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {priced ? (
            <div className="flex flex-col items-end gap-1 mt-3 text-sm">
              <span className="text-[#9ca3af]">Subtotal <span className="tabular-nums text-[#e5e5e5]">{money(doc.subtotal)}</span></span>
              <span className="text-[#9ca3af]">Tax <span className="tabular-nums text-[#e5e5e5]">{money(doc.tax_total)}</span></span>
              <span className="text-[#FF7026] font-bold">Total ({doc.currency}) <span className="tabular-nums">{money(doc.total)}</span></span>
              {doc.fx && (
                <span className="text-[10px] text-[#6b7280]">FX {doc.fx.pair} @ {doc.fx.rate} ({doc.fx.method})</span>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-[#4b5563] mt-3">Values hidden — you don&apos;t have cost visibility (cost.view).</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              Close
            </Dialog.Close>
            <button
              onClick={downloadPdf}
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
