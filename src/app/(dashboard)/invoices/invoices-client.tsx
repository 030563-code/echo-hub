"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Pencil } from "lucide-react";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import CommercialInvoiceModal from "../transport/CommercialInvoiceModal";
import InvoiceDraftEditor from "./InvoiceDraftEditor";
import { setInvoiceStatus } from "@/app/actions/invoices/set-invoice-status";
import type { InvoiceListRow } from "./page";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-[#2a2a2a] text-[#9ca3af]",
  issued: "bg-green-900/30 text-green-400",
  void: "bg-red-900/25 text-red-400 line-through",
};

export default function InvoicesClient({
  invoices,
  canViewCost,
  canManage,
}: {
  invoices: InvoiceListRow[];
  canViewCost: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<CommercialInvoiceDoc | null>(null);
  const [editing, setEditing] = useState<InvoiceListRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function transition(id: string, action: "issue" | "void") {
    if (action === "void" && !window.confirm("Void this invoice? It stays in the list for the audit trail and frees the container/leg to be re-issued.")) return;
    setErr(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await setInvoiceStatus({ invoice_id: id, action });
      setBusyId(null);
      if (!res.ok) setErr(res.error);
      else router.refresh();
    });
  }

  const money = (d: CommercialInvoiceDoc) =>
    d.total == null
      ? "—"
      : `${d.currency === "USD" ? "$" : "€"}${d.total.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Commercial Invoices
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Intercompany invoices issued per container — SRO→Group (EUR) · Group→USA (USD)
        </p>
      </div>

      {err && <p className="text-xs text-red-400 mb-3">{err}</p>}

      {invoices.length === 0 ? (
        <p className="text-sm text-[#6b7280]">No commercial invoices issued yet. Generate them from <a href="/transport" className="text-[#FF7026] hover:underline">Transport</a> — pick a container and choose the EUR or USD leg.</p>
      ) : (
        <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                <th className="text-left font-medium px-4 py-2.5">Invoice #</th>
                <th className="text-left font-medium px-4 py-2.5">Date</th>
                <th className="text-left font-medium px-4 py-2.5">Route</th>
                <th className="text-left font-medium px-4 py-2.5">Container</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5">Total</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-[#222] hover:bg-[#1a1a1a] transition-colors cursor-pointer"
                  onClick={() => setOpen(r.doc)}
                >
                  <td className="px-4 py-2.5 font-mono text-[#FF7026]">{r.doc.invoice_number}</td>
                  <td className="px-4 py-2.5 text-[#9ca3af]">{r.doc.date}</td>
                  <td className="px-4 py-2.5 text-[#9ca3af]">{r.doc.seller.code} → {r.doc.buyer.code}</td>
                  <td className="px-4 py-2.5 font-mono text-[#9ca3af]">{r.doc.container_ref ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${STATUS_STYLE[r.status] ?? STATUS_STYLE.draft}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#e5e5e5]">{money(r.doc)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      {canManage && r.status === "draft" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); transition(r.id, "issue"); }}
                          disabled={pending}
                          className="px-2.5 py-1.5 text-xs text-green-400 hover:text-green-300 border border-[#2a2a2a] hover:border-green-800/50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {pending && busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Issue"}
                        </button>
                      )}
                      {canManage && canViewCost && r.status === "draft" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditing(r); }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors"
                          title="Edit the draft lines before issuing (bundle, split, set HS codes, correct a price)"
                        >
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                      )}
                      {canManage && r.status !== "void" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); transition(r.id, "void"); }}
                          disabled={pending}
                          className="px-2.5 py-1.5 text-xs text-red-400 hover:text-red-300 border border-[#2a2a2a] hover:border-red-800/50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          Void
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setOpen(r.doc); }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5" /> View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canViewCost && invoices.length > 0 && (
        <p className="text-[10px] text-[#4b5563] mt-2">Values hidden — you don&apos;t have cost visibility (cost.view).</p>
      )}

      {open && <CommercialInvoiceModal doc={open} onClose={() => setOpen(null)} />}
      {editing && (
        <InvoiceDraftEditor
          invoiceId={editing.id}
          doc={editing.doc}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); router.refresh(); }}
        />
      )}
    </div>
  );
}
