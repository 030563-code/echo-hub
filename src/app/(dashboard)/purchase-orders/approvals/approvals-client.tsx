"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { Check, X, Loader2, Inbox, AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatRelative } from "@/lib/utils";
import { decidePurchaseOrder } from "@/app/actions/purchase-orders/decide-po";
import { entityLabel } from "@/lib/depot-constants";
import { chainNumber, displayPoNumber } from "@/lib/po-number";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchBox } from "@/components/ui/search-box";
import type { PurchaseOrder } from "@/lib/erp-types";
import { usePersistedView } from "@/hooks/use-page-state";
import { parseSearchView, type SearchView } from "@/lib/page-drafts";

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

const TIERS: { leg: PurchaseOrder["leg"]; n: number; title: string; route: string }[] = [
  { leg: "DEPOT_TO_EB_GROUP", n: 1, title: "Depot", route: "Depot → EB Group" },
  { leg: "EB_GROUP_TO_SRO", n: 2, title: "Group", route: "EB Group → EB SRO" },
  { leg: "SRO_TO_SUPPLIER", n: 3, title: "SRO", route: "EB SRO → Supplier" },
];

export default function ApprovalsClient({ orders, canViewCost }: { orders: PurchaseOrder[]; canViewCost: boolean }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "success" | "warn" | "error"; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PurchaseOrder | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  // Approvals is a queue people filter and step away from, so the box survives the trip.
  const [qView, setQView] = usePersistedView<SearchView>(
    "po-approvals",
    { v: 1, q: "" },
    parseSearchView,
  );
  const q = qView.q;
  const setQ = (next: string) => setQView({ v: 1, q: next });

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return orders;
    return orders.filter((o) =>
      [o.po_number, chainNumber(o), o.from_entity, o.to_entity, o.status, o.reference_po_number, o.requested_by]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s))
    );
  }, [orders, q]);

  const groups = useMemo(
    () => TIERS.map((t) => ({ ...t, items: filtered.filter((o) => o.leg === t.leg) })).filter((g) => g.items.length),
    [filtered]
  );

  function approve(po: PurchaseOrder) {
    setNotice(null);
    setBusyId(po.id);
    startTransition(async () => {
      const res = await decidePurchaseOrder({ poId: po.id, decision: "approve" });
      setBusyId(null);
      if (!res.success) {
        setNotice({ kind: "error", text: res.error });
        toast.error(res.error);
      } else if (res.warning) {
        setNotice({ kind: "warn", text: res.warning });
        toast.warning(res.warning);
      } else {
        const text = res.nextPoNumber
          ? `${res.tier} approved. The next tier was raised as ${res.nextPoNumber}.`
          : res.awaitingFulfilment
            ? `${res.tier} approved. It is now with SRO, who choose whether to fulfil it from stock or manufacture it.`
            : `${res.tier} approved. Final tier, the chain is complete.`;
        setNotice({ kind: "success", text });
        toast.success(text);
      }
      router.refresh();
    });
  }

  function confirmReject() {
    if (!rejectTarget) return;
    const po = rejectTarget;
    setNotice(null);
    setBusyId(po.id);
    startTransition(async () => {
      const res = await decidePurchaseOrder({ poId: po.id, decision: "reject", note: rejectNote.trim() || undefined });
      setBusyId(null);
      setRejectTarget(null);
      setRejectNote("");
      if (!res.success) {
        setNotice({ kind: "error", text: res.error });
        toast.error(res.error);
      } else {
        toast.success(`${displayPoNumber(po.po_number)} rejected`);
      }
      router.refresh();
    });
  }

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="w-8 h-8" />}
        title="Nothing awaiting approval"
        description="Raised POs flow through three approvals — Depot → Group → SRO — and appear here at each tier."
        action={
          <Link
            href="/purchase-orders/create"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg transition-colors"
          >
            Raise a PO
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-400">{filtered.length} awaiting approval</span>
        <SearchBox value={q} onChange={setQ} placeholder="Search PO, entity, ref…" />
      </div>

      {notice && (
        <p
          className={
            "flex items-start gap-2 text-sm rounded-lg px-3 py-2 border " +
            (notice.kind === "error"
              ? "text-red-700 bg-red-50 border-red-200"
              : notice.kind === "warn"
                ? "text-amber-700 bg-amber-50 border-amber-200"
                : "text-green-700 bg-green-50 border-green-200")
          }
        >
          {notice.kind === "success" ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          )}
          {notice.text}
        </p>
      )}

      {groups.length === 0 && (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title="No matching approvals"
          description="No pending PO matches your search. Try a different PO number, entity or reference."
        />
      )}

      {groups.map((g) => (
        <div key={g.leg}>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-echo-orange text-white text-[11px] font-bold">
              {g.n}
            </span>
            <h2 className="text-sm font-semibold text-gray-900">Approval {g.n} · {g.title}</h2>
            <span className="text-xs text-gray-400">{g.route}</span>
            <span className="text-xs text-gray-400">· {g.items.length}</span>
          </div>

          <div className="space-y-4">
            {g.items.map((po) => {
              const busy = busyId === po.id;
              return (
                <div key={po.id} className="bg-white border border-gray-200 rounded-xl p-5">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-3">
                    <div>
                      <p className="font-mono text-echo-orange font-medium">{displayPoNumber(po.po_number)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        <span>{entityLabel(po.from_entity)}</span> →{" "}
                        <span>{entityLabel(po.to_entity)}</span>
                        <span className="text-gray-400"> · raised {formatRelative(po.created_at)}</span>
                        {po.requested_by && <span className="text-gray-400"> by {po.requested_by}</span>}
                      </p>
                      {po.reference_po_number && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          ref: <span className="font-mono text-gray-600">{displayPoNumber(po.reference_po_number)}</span>
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setRejectTarget(po)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-3 sm:py-1.5 text-sm text-red-700 hover:bg-red-50 border border-red-200 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <X className="w-3.5 h-3.5" />
                        Reject
                      </button>
                      <button
                        onClick={() => approve(po)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-3 sm:py-1.5 text-sm text-white bg-green-700/80 hover:bg-green-600 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        Approve
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-gray-100 overflow-x-auto">
                    <table className="w-full min-w-[480px] text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                          <th className="text-left font-medium px-3 py-1.5">Product</th>
                          <th className="text-right font-medium px-3 py-1.5">Qty</th>
                          <th className="text-left font-medium px-3 py-1.5">HS code</th>
                          {canViewCost && <th className="text-right font-medium px-3 py-1.5">Unit price</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {(po.lines ?? []).map((l) => (
                          <tr key={l.id} className="border-t border-gray-100">
                            <td className="px-3 py-1.5">
                              <span className="font-mono text-xs text-gray-900">{l.sku}</span>
                              {l.product_name && <span className="text-gray-500 text-xs"> — {l.product_name}</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{l.quantity}</td>
                            <td className="px-3 py-1.5 font-mono text-xs text-gray-600">{l.hs_code ?? "—"}</td>
                            {canViewCost && (
                              <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">
                                {l.unit_price != null ? l.unit_price.toLocaleString() : "—"}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {(po.delivery_address || po.notes) && (
                    <div className="mt-3 space-y-1">
                      {po.delivery_address && (
                        <p className="text-xs text-gray-500">
                          <span className="text-gray-400">Deliver to:</span> {po.delivery_address}
                        </p>
                      )}
                      {po.notes && (
                        <p className="text-xs text-gray-500">
                          <span className="text-gray-400">Notes:</span> {po.notes}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <Dialog.Root open={rejectTarget !== null} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100%-2rem)] sm:w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto bg-white border border-gray-200 rounded-2xl p-6 shadow-2xl">
            <Dialog.Title className="text-lg font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Reject {rejectTarget ? displayPoNumber(rejectTarget.po_number) : ""}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-gray-500 mt-1 mb-4">
              This marks the PO rejected and stops the chain at this tier. Add an optional reason.
            </Dialog.Description>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              placeholder="Reason (optional)…"
              className={inputCls + " resize-none"}
            />
            <div className="flex justify-end gap-2 mt-4">
              <Dialog.Close className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
                Cancel
              </Dialog.Close>
              <button
                onClick={confirmReject}
                disabled={busyId === rejectTarget?.id}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-700/80 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60"
              >
                {busyId === rejectTarget?.id && <Loader2 className="w-4 h-4 animate-spin" />}
                Reject PO
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
