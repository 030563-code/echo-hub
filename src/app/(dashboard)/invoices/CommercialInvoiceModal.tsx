"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X, FileDown } from "lucide-react";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { EB_GREEN, drawBrandHeader } from "@/lib/pdf-brand";

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

    // ---- Branded header (shared EB logo + green rule) ----
    const partyY = await drawBrandHeader(d, W, {
      title: "COMMERCIAL INVOICE",
      refs: [`Invoice: ${doc.invoice_number}`, `Date: ${doc.date}`, `Reference: ${doc.po_reference ?? "—"}`],
    });

    // ---- Seller / Buyer ----
    d.setFontSize(9);
    d.setFont("helvetica", "bold");
    d.text("Seller", 14, partyY);
    d.text("Buyer", W / 2 + 6, partyY);
    d.setFont("helvetica", "normal");
    d.text([doc.seller.legal_name, ...doc.seller.address_lines, `VAT: ${doc.seller.vat_tax_id ?? "—"}`], 14, partyY + 5);
    d.text([doc.buyer.legal_name, ...doc.buyer.address_lines, `VAT: ${doc.buyer.vat_tax_id ?? "—"}`], W / 2 + 6, partyY + 5);

    const refLines = [
      `Container: ${doc.container_ref ?? "—"}`,
      `SPOT ID: ${doc.spot_id ?? "—"}`,
      `PO ref: ${doc.po_reference ?? "—"}`,
      `Currency: ${doc.currency}`,
    ];
    d.text(refLines, 14, partyY + 30);

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
      startY: 98,
      head,
      body,
      styles: { fontSize: 9 },
      headStyles: { fillColor: EB_GREEN, textColor: [255, 255, 255], fontStyle: "bold" },
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
      d.setTextColor(EB_GREEN[0], EB_GREEN[1], EB_GREEN[2]);
      d.text(`TOTAL (${doc.currency})   ${(doc.total ?? 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
      d.setTextColor(0, 0, 0);
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
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white border border-gray-200 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Commercial Invoice — <span className="font-mono text-echo-orange">{doc.invoice_number}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-gray-400 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            {doc.seller.legal_name} → {doc.buyer.legal_name} · container{" "}
            <span className="font-mono text-gray-600">{doc.container_ref ?? "—"}</span> · {doc.currency}
          </p>

          {warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-700 mb-2">⚠ {w}</p>
          ))}

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="text-left font-medium px-3 py-2">SKU</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-right font-medium px-3 py-2">Qty</th>
                  {priced && <th className="text-right font-medium px-3 py-2">Unit value</th>}
                  {priced && <th className="text-right font-medium px-3 py-2">Line total</th>}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-mono text-gray-900">{l.sku}</td>
                    <td className="px-3 py-2 text-gray-600">{l.product_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600">{l.qty}</td>
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-gray-500">{money(l.unit_value)}</td>}
                    {priced && <td className="px-3 py-2 text-right tabular-nums text-gray-900">{money(l.line_total)}</td>}
                  </tr>
                ))}
                {doc.lines.length === 0 && (
                  <tr>
                    <td colSpan={priced ? 5 : 3} className="px-3 py-6 text-center text-gray-400">No lines.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {priced ? (
            <div className="flex flex-col items-end gap-1 mt-3 text-sm">
              <span className="text-gray-600">Subtotal <span className="tabular-nums text-gray-900">{money(doc.subtotal)}</span></span>
              <span className="text-gray-600">Tax <span className="tabular-nums text-gray-900">{money(doc.tax_total)}</span></span>
              <span className="text-echo-orange font-bold">Total ({doc.currency}) <span className="tabular-nums">{money(doc.total)}</span></span>
              {doc.fx && (
                <span className="text-[10px] text-gray-500">FX {doc.fx.pair} @ {doc.fx.rate} ({doc.fx.method})</span>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-gray-400 mt-3">Values hidden — you don&apos;t have cost visibility (cost.view).</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
              Close
            </Dialog.Close>
            <button
              onClick={downloadPdf}
              className="inline-flex items-center gap-2 px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <FileDown className="w-4 h-4" /> Download PDF
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
