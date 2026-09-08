"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Pencil, Receipt } from "lucide-react";
import { toast } from "sonner";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import CommercialInvoiceModal from "./CommercialInvoiceModal";
import InvoiceDraftEditor from "./InvoiceDraftEditor";
import { setInvoiceStatus } from "@/app/actions/invoices/set-invoice-status";
import type { InvoiceListRow } from "./page";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchBox } from "@/components/ui/search-box";
import { usePersistedView } from "@/hooks/use-page-state";
import { parseSearchView, type SearchView } from "@/lib/page-drafts";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  issued: "bg-green-50 text-green-800 border border-green-200",
  void: "bg-red-50 text-red-700 border border-red-200 line-through",
};

export default function InvoicesClient({
  invoices,
  canViewCost,
  canManage,
  createSlot,
}: {
  invoices: InvoiceListRow[];
  canViewCost: boolean;
  canManage: boolean;
  /** The "generate from a container" panel — rendered under the header. */
  createSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<CommercialInvoiceDoc | null>(null);
  const [editing, setEditing] = useState<InvoiceListRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Its own key: the create panel beside this list owns a separate one, and one row per call site is the rule.
  const [qView, setQView] = usePersistedView<SearchView>(
    "commercial-invoices:list",
    { v: 1, q: "" },
    parseSearchView,
  );
  const q = qView.q;
  const setQ = (next: string) => setQView({ v: 1, q: next });

  function transition(id: string, action: "issue" | "void") {
    if (action === "void" && !window.confirm("Void this invoice? It stays in the list for the audit trail and frees the container/leg to be re-issued.")) return;
    setErr(null);
    setBusyId(id);
    const num = invoices.find((r) => r.id === id)?.doc.invoice_number ?? "";
    startTransition(async () => {
      const res = await setInvoiceStatus({ invoice_id: id, action });
      setBusyId(null);
      if (!res.ok) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success(action === "issue" ? `Invoice ${num} issued` : `Invoice ${num} voided`);
        router.refresh();
      }
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return invoices;
    return invoices.filter((r) =>
      [
        r.doc.invoice_number,
        `${r.doc.seller.code} → ${r.doc.buyer.code}`,
        r.doc.seller.code,
        r.doc.buyer.code,
        r.doc.container_ref ?? "",
        r.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [invoices, q]);

  const money = (d: CommercialInvoiceDoc) =>
    d.total == null
      ? "—"
      : `${d.currency === "USD" ? "$" : "€"}${d.total.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
            Commercial Invoices
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Intercompany invoices issued per container — SRO→Group (EUR) · Group→USA (USD)
          </p>
        </div>
        {invoices.length > 0 && (
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder="Search invoice, route, container…"
            className="w-64 shrink-0"
          />
        )}
      </div>

      {createSlot}

      {err && <p className="text-xs text-red-700 mb-3">{err}</p>}

      {invoices.length === 0 ? (
        <EmptyState
          icon={<Receipt className="w-8 h-8" />}
          title="No commercial invoices issued yet"
          description="Pick a container above and choose the EUR (SRO→Group) or USD (Group→USA) leg to generate one."
        />
      ) : (
        <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
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
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500">
                    No invoices match “{q}”.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                  onClick={() => setOpen(r.doc)}
                >
                  <td className="px-4 py-2.5 font-mono text-echo-orange">{r.doc.invoice_number}</td>
                  <td className="px-4 py-2.5 text-gray-600">{r.doc.date}</td>
                  <td className="px-4 py-2.5 text-gray-600">{r.doc.seller.code} → {r.doc.buyer.code}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-600">{r.doc.container_ref ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${STATUS_STYLE[r.status] ?? STATUS_STYLE.draft}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">{money(r.doc)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      {canManage && r.status === "draft" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); transition(r.id, "issue"); }}
                          disabled={pending}
                          className="px-2.5 py-1.5 text-xs text-green-700 hover:text-green-800 border border-gray-300 hover:border-green-200 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {pending && busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Issue"}
                        </button>
                      )}
                      {canManage && canViewCost && r.status === "draft" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditing(r); }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors"
                          title="Edit the draft lines before issuing (bundle, split, set HS codes, correct a price)"
                        >
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                      )}
                      {canManage && r.status !== "void" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); transition(r.id, "void"); }}
                          disabled={pending}
                          className="px-2.5 py-1.5 text-xs text-red-700 hover:text-red-800 border border-gray-300 hover:border-red-200 rounded-lg transition-colors disabled:opacity-50"
                        >
                          Void
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setOpen(r.doc); }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors"
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
        <p className="text-[10px] text-gray-400 mt-2">Values hidden — you don&apos;t have cost visibility (cost.view).</p>
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
