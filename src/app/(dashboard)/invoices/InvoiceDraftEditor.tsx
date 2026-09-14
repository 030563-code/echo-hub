"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, useTransition } from "react";
import { X, Plus, Trash2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { editInvoiceDraft } from "@/app/actions/invoices/edit-invoice-draft";
import { usePageState } from "@/hooks/use-page-state";
import { DraftStrip } from "@/components/page-state/draft-strip";
import {
  commercialInvoiceKey,
  parseCommercialInvoiceDraft,
  type CommercialInvoiceDraft,
} from "@/lib/page-drafts";
import { currencySymbol } from "@/lib/invoice-legs";
import { cn } from "@/lib/utils";
import { isValidHsCode, normaliseHsCode, splitPartSkus } from "@/lib/hs-codes";

// Editable-draft override. Full manual control over a DRAFT invoice's lines before
// issuing: edit a description/price/HS code, DELETE ancillary lines (consolidation),
// or ADD lines (split a product into HS-coded parts). Totals recompute live and are
// re-reconciled server-side on save; every edit is audited. Draft only.

/** A saved product_hs_codes row: the code for one product on one leg. */
export interface SavedHsCode {
  sku: string;
  leg: string;
  hs_code: string;
}

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
  savedHsCodes,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  doc: CommercialInvoiceDoc;
  savedHsCodes: SavedHsCode[];
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
  // Line indexes whose HS code format error is on show. Revealed on blur or
  // Enter, hidden again while that box is being typed in, so the message never
  // flickers or re-announces on each keystroke.
  const [revealedHs, setRevealedHs] = useState<Record<number, true>>({});
  const sym = currencySymbol(doc.currency);

  // Unsaved line edits, kept across a close and a reopen.
  //
  // Fingerprinted on the lines this was opened against: if the invoice was
  // regenerated in the meantime, the typing belongs to a different set of lines
  // and is dropped rather than reapplied on top.
  const storedRows = () =>
    doc.lines.map((l) => ({
      sku: l.sku,
      product_name: l.product_name,
      qty: String(l.qty),
      unit_value: String(l.unit_value ?? 0),
      hs_code: l.hs_code ?? "",
    }));
  const draftBase = JSON.stringify(storedRows());

  const {
    restored: restoredDraft,
    save: saveDraft,
    clear: clearDraft,
    saveStatus: draftSaveStatus,
    savedAt: draftSavedAt,
  } = usePageState<CommercialInvoiceDraft>({
    pageKey: commercialInvoiceKey(invoiceId),
    parse: parseCommercialInvoiceDraft,
    base: draftBase,
    onRestore: (restored) => {
      if (!restored) return;
      if (restored.stale) {
        void clearDraft();
        return;
      }
      setRows(restored.data.rows);
    },
    // Untouched lines are not an edit; only a real change is worth keeping.
    isEmpty: (d) => JSON.stringify(d.rows) === draftBase,
  });

  useEffect(() => {
    saveDraft({ v: 1, rows });
  }, [saveDraft, rows]);

  // HS codes: blank saves (the draft just cannot be issued yet); anything typed
  // must pass the same rule the database and the server action apply.
  const hsState = rows.map((r, i) => {
    const code = normaliseHsCode(r.hs_code);
    const invalid = code !== "" && !isValidHsCode(code);
    return { code, missing: code === "", invalid, shown: invalid && !!revealedHs[i] };
  });
  const missingCount = hsState.filter((h) => h.missing).length;
  const invalidLines = hsState.flatMap((h, i) => (h.invalid ? [i + 1] : []));
  const shownInvalidLines = hsState.flatMap((h, i) => (h.shown ? [i + 1] : []));
  const savedForLeg = new Map(savedHsCodes.filter((c) => c.leg === doc.leg).map((c) => [c.sku, c.hs_code]));
  // A SKU on more than one line is the set of parts a split rule made. The HS
  // codes tab holds one code per SKU, so copying it onto every part would print
  // the parent's code on each: those lines are typed by hand, never filled.
  const splitSkus = splitPartSkus(rows);
  const canFill = (r: Row) => normaliseHsCode(r.hs_code) === "" && !splitSkus.has(r.sku.trim()) && savedForLeg.has(r.sku.trim());
  const fillable = rows.filter(canFill).length;
  const missingSplitParts = rows.filter((r, i) => hsState[i].missing && splitSkus.has(r.sku.trim())).length;
  const fillBlankCodes = () =>
    setRows((rs) => {
      const parts = splitPartSkus(rs);
      return rs.map((r) =>
        normaliseHsCode(r.hs_code) === "" && !parts.has(r.sku.trim()) && savedForLeg.has(r.sku.trim())
          ? { ...r, hs_code: savedForLeg.get(r.sku.trim()) ?? "" }
          : r
      );
    });
  const revealHs = (i: number) => {
    if (hsState[i]?.invalid) setRevealedHs((cur) => ({ ...cur, [i]: true }));
  };

  const lineTotal = (r: Row) => round2(num(r.qty) * round2(num(r.unit_value)));
  const subtotal = round2(rows.reduce((s, r) => s + lineTotal(r), 0));

  const update = (i: number, key: keyof Row, val: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows((rs) => [...rs, { sku: "", product_name: "", qty: "1", unit_value: "0", hs_code: "" }]);
  const del = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    // Line numbers shift down past a deleted line, and so do their revealed errors.
    setRevealedHs((cur) => {
      const next: Record<number, true> = {};
      for (const k of Object.keys(cur).map(Number)) {
        if (k < i) next[k] = true;
        else if (k > i) next[k - 1] = true;
      }
      return next;
    });
  };

  function save() {
    setErr(null);
    if (!rows.length) {
      setErr("An invoice needs at least one line.");
      return;
    }
    if (invalidLines.length) {
      setRevealedHs((cur) => ({ ...cur, ...Object.fromEntries(invalidLines.map((n) => [n - 1, true as const])) }));
      setErr(`Fix the HS code on line ${invalidLines.join(", ")} first.`);
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
          hs_code: normaliseHsCode(r.hs_code) || null,
        })),
      });
      if (!res.ok) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success("Draft saved");
        // The edits are on the invoice now.
        void clearDraft();
        onSaved();
      }
    });
  }

  const inputCls =
    "w-full bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-900 focus:border-echo-orange focus:outline-none";

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-white border border-gray-200 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Edit draft — <span className="font-mono text-echo-orange">{doc.invoice_number}</span>
            </Dialog.Title>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
              <X className="w-4 h-4" />
            </button>
          </div>
          {restoredDraft && (
            <div className="mb-4">
              <DraftStrip
                what="the line edits you had typed"
                savedAt={draftSavedAt}
                onStartAgain={async () => {
                  await clearDraft();
                  setRows(storedRows());
                }}
                startAgainLabel="Discard them"
                saveStatus={draftSaveStatus}
              />
            </div>
          )}

          <p className="text-xs text-gray-500 mb-4">
            Adjust the lines for customs — bundle (delete a line, fold its value into another), split (add lines with their own HS
            codes), or correct a price. Totals recompute automatically and every change is recorded. Draft only.
          </p>

          {err && <p className="text-xs text-red-700 mb-3">{err}</p>}

          {missingCount > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>
                {missingCount === 1 ? "1 line has" : `${missingCount} lines have`} no HS code. You can save the draft like this, but it
                cannot be issued until every line has one.
                {missingSplitParts > 0 &&
                  ` ${missingSplitParts === 1 ? "1 of them is a split part" : `${missingSplitParts} of them are split parts`} sharing a SKU with another line, which the HS codes tab cannot fill, so type ${missingSplitParts === 1 ? "its code" : "those codes"} here.`}
              </span>
              {fillable > 0 && (
                <button
                  type="button"
                  onClick={fillBlankCodes}
                  className="ml-auto px-2.5 py-1 rounded-md border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 transition-colors"
                >
                  Fill {fillable === 1 ? "1 blank code" : `${fillable} blank codes`} from the HS codes tab
                </button>
              )}
            </div>
          )}

          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
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
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2 py-1.5"><input className={`${inputCls} font-mono`} value={r.sku} onChange={(e) => update(i, "sku", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={inputCls} value={r.product_name} onChange={(e) => update(i, "product_name", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={`${inputCls} text-right`} inputMode="decimal" value={r.qty} onChange={(e) => update(i, "qty", e.target.value)} /></td>
                    <td className="px-2 py-1.5"><input className={`${inputCls} text-right`} inputMode="decimal" value={r.unit_value} onChange={(e) => update(i, "unit_value", e.target.value)} /></td>
                    <td className="px-2 py-1.5">
                      <input
                        className={cn(inputCls, "font-mono", hsState[i].shown && "border-red-500 focus:border-red-600", hsState[i].missing && "border-amber-400")}
                        placeholder="Needed"
                        aria-label={`HS code, line ${i + 1}`}
                        aria-invalid={hsState[i].shown || undefined}
                        aria-describedby={hsState[i].shown ? "draft-hs-code-error" : undefined}
                        value={r.hs_code}
                        onChange={(e) => {
                          update(i, "hs_code", e.target.value);
                          if (revealedHs[i]) {
                            setRevealedHs((cur) => {
                              const next = { ...cur };
                              delete next[i];
                              return next;
                            });
                          }
                        }}
                        onBlur={() => revealHs(i)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") revealHs(i);
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-900">{sym}{lineTotal(r).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-2 py-1.5 text-center">
                      <button onClick={() => del(i)} className="p-1 text-gray-400 hover:text-red-700 transition-colors" title="Delete line">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shownInvalidLines.length > 0 && (
            <p id="draft-hs-code-error" className="mt-2 text-xs text-red-700">
              The HS code on line {shownInvalidLines.join(", ")} is not valid. An HS code is 6 to 10 digits, split by single dots or
              spaces, for example 3926.90 or 3926 90 97.
            </p>
          )}

          <div className="flex items-center justify-between mt-3">
            <button onClick={addRow} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add line
            </button>
            <div className="text-sm text-echo-orange font-bold">
              Subtotal ({doc.currency}) <span className="tabular-nums">{sym}{subtotal.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">Cancel</button>
            <button
              onClick={save}
              disabled={pending || invalidLines.length > 0}
              className="inline-flex items-center gap-2 px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
