"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { X, Plus, Trash2, Loader2, Save } from "lucide-react";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { editInvoiceDraft } from "@/app/actions/invoices/edit-invoice-draft";

// Editable-draft override. Full manual control over a DRAFT invoice's lines before
// issuing: edit a description/price/HS code, DELETE ancillary lines (consolidation),
// or ADD lines (split a product into HS-coded parts). Totals recompute live and are
// re-reconciled server-side on save; every edit is audited. Draft only.

interface Row {
  sku: string;
  product_name: string;
  qty: string;
  unit_value: string;
  hs_code: string;
}

const num = (s: string) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};
const round2 = (v: number) => Math.round(v * 100) / 100;

export default function InvoiceDraftEditor({
  invoiceId,
  doc,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  doc: CommercialInvoiceDoc;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    doc.lines.map((l) => ({
      sku: l.sku,
      product_name: l.product_name,
      qty: String(l.qty),
      unit_value: String(l.unit_value ?? 0),
      hs_code: l.hs_code ?? "",
    }))
  );
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const sym = doc.currency === "USD" ? "$" : "€";

  const lineTotal = (r: Row) => round2(num(r.qty) * round2(num(r.unit_value)));
  const subtotal = round2(rows.reduce((s, r) => s + lineTotal(r), 0));

  const update = (i: number, key: keyof Row, val: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows((rs) => [...rs, { sku: "", product_name: "", qty: "1", unit_value: "0", hs_code: "" }]);
  const del = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  function save() {
    setErr(null);
    if (!rows.length) {
      setErr("An invoice needs at least one line.");
      return;
    }
    start(async () => {
      const res = await editInvoiceDraft({
        invoice_id: invoiceId,
        lines: rows.map((r) => ({
          sku: r.sku.trim() || "—",
          product_name: r.product_name.trim() || r.sku.trim() || "—",
          qty: num(r.qty),
          unit_value: num(r.unit_value),
          hs_code: r.hs_code.trim() || null,
        })),
      });
      if (!res.ok) setErr(res.error);
      else onSaved();
    });
  }

  const inputCls =
    "w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-[#e5e5e5] focus:border-[#FF7026] focus:outline-none";

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Edit draft — <span className="font-mono text-[#FF7026]">{doc.invoice_number}</span>
            </Dialog.Title>
            <button onClick={onClose} className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-[#6b7280] mb-4">
            Adjust the lines for customs — bundle (delete a line, fold its value into another), split (add lines with their own HS
            codes), or correct a price. Totals recompute automatically and every change is recorded. Draft only.
          </p>

          {err && <p className="text-xs text-red-400 mb-3">{err}</p>}

          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                  <th className="text-left font-medium px-2 py-2 w-[14%]">SKU</th>
                  <th className="text-left font-medium px-2 py-2">Description</th>
                  <th className="text-right font-medium px-2 py-2 w-[9%]">Qty</th>
                  <th className="text-right font-medium px-2 py-2 w-[14%]">Unit value</th>
                  <th className="text-left font-medium px-2 py-2 w-[14%]">HS code</th>
                  <th className="text-right font-medium px-2 py-2 w-[12%]">Line total</th>
                  <th className="px-2 py-2 w-[4%]" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-[#222]">
                    <td className="px-2 py-1.5"><input className={`${inputCls} font-mono`} value={r.sku} onChange={(e) => update(i, "sku", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={inputCls} value={r.product_name} onChange={(e) => update(i, "product_name", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={`${inputCls} text-right`} inputMode="decimal" value={r.qty} onChange={(e) => update(i, "qty", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={`${inputCls} text-right`} inputMode="decimal" value={r.unit_value} onChange={(e) => update(i, "unit_value", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={`${inputCls} font-mono`} placeholder="—" value={r.hs_code} onChange={(e) => update(i, "hs_code", e.target.value)} /></td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[#e5e5e5]">{sym}{lineTotal(r).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-2 py-1.5 text-center">
                      <button onClick={() => del(i)} className="p-1 text-[#4b5563] hover:text-red-400 transition-colors" title="Delete line">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-3">
            <button onClick={addRow} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add line
            </button>
            <div className="text-sm text-[#FF7026] font-bold">
              Subtotal ({doc.currency}) <span className="tabular-nums">{sym}{subtotal.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">Cancel</button>
            <button
              onClick={save}
              disabled={pending}
              className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
