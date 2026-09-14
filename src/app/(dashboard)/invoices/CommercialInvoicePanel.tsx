"use client";

import { useMemo, useState, useTransition } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ShipmentContent } from "@/lib/erp-types";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { generateCommercialInvoice } from "@/app/actions/invoices/generate-commercial-invoice";
import CommercialInvoiceModal from "./CommercialInvoiceModal";
import { usePersistedView } from "@/hooks/use-page-state";
import { parseSearchView, type SearchView } from "@/lib/page-drafts";
import { INVOICE_LEGS, LEG_CONFIG, legsForDestination, type InvoiceLeg } from "@/lib/invoice-legs";

interface ContainerGroup {
  container_ref: string;
  skus: number;
  units: number;
  po_references: string[];
  spot_id: string | null;
  /** The legs this container needs, from its lines' depot codes. */
  legs: InvoiceLeg[];
  /** The distinct depot codes on its lines, sorted. */
  depots: string[];
  /** How many of its lines have no depot code, and how many lines it has. */
  linesWithoutDepot: number;
  lines: number;
}

/**
 * Why a container is offered both Group invoices, in plain words, or null when
 * its depots decide the legs. legsForDestination offers both onward legs when a
 * line has no depot, because that line could be bound for either country;
 * saying so stops the Canada button looking like it came from nowhere.
 */
function unknownDepotNote(c: Pick<ContainerGroup, "linesWithoutDepot" | "lines">): string | null {
  if (c.linesWithoutDepot === 0) return null;
  if (c.linesWithoutDepot === c.lines) {
    return c.lines === 1
      ? "Its line has no depot, so both Group invoices are offered."
      : "None of its lines has a depot, so both Group invoices are offered.";
  }
  return `${c.linesWithoutDepot === 1 ? "1 line has" : `${c.linesWithoutDepot} lines have`} no depot, so both Group invoices are offered.`;
}

export default function CommercialInvoicePanel({
  items,
  canCreate,
}: {
  items: ShipmentContent[];
  canCreate: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ doc: CommercialInvoiceDoc; warnings: string[] } | null>(null);
  // Reuses the plain {q} shape: one remembered string is one remembered string,
  // and a second schema for the same thing would only be a second thing to keep
  // in step.
  const [destView, setDestView] = usePersistedView<SearchView>(
    "commercial-invoices:create",
    { v: 1, q: "" },
    parseSearchView,
  );
  const destCountry = destView.q;
  const setDestCountry = (next: string) => setDestView({ v: 1, q: next });

  const containers = useMemo<ContainerGroup[]>(() => {
    const byRef = new Map<string, { skus: Set<string>; units: number; pos: Set<string>; spot: string | null; depots: (string | null)[] }>();
    for (const it of items) {
      if (!it.container_ref) continue;
      const g = byRef.get(it.container_ref) ?? { skus: new Set<string>(), units: 0, pos: new Set<string>(), spot: null, depots: [] };
      g.skus.add(it.sku);
      g.units += it.qty;
      if (it.po_reference) g.pos.add(it.po_reference);
      g.spot = g.spot ?? it.spot_id;
      g.depots.push(it.depot_destination);
      byRef.set(it.container_ref, g);
    }
    return [...byRef.entries()]
      .map(([container_ref, g]) => ({
        container_ref,
        skus: g.skus.size,
        units: g.units,
        po_references: [...g.pos].sort(),
        spot_id: g.spot,
        legs: legsForDestination(g.depots),
        depots: [...new Set(g.depots.map((d) => (d ?? "").trim()).filter(Boolean))].sort(),
        linesWithoutDepot: g.depots.filter((d) => (d ?? "").trim() === "").length,
        lines: g.depots.length,
      }))
      .sort((a, b) => a.container_ref.localeCompare(b.container_ref));
  }, [items]);

  function generate(container_ref: string, leg: InvoiceLeg) {
    setError(null);
    setBusyRef(`${container_ref}:${leg}`);
    startTransition(async () => {
      const res = await generateCommercialInvoice({ container_ref, leg, destination_country: destCountry.trim() || undefined });
      setBusyRef(null);
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      toast.success(
        `Invoice ${res.doc.invoice_number} generated`,
        res.warnings.length ? { description: res.warnings.join(" · ") } : undefined
      );
      setOpen({ doc: res.doc, warnings: res.warnings });
    });
  }

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
          New invoice from a container
        </h2>
        <span className="text-[10px] text-gray-400">
          One per container and leg: {INVOICE_LEGS.map((leg) => `${LEG_CONFIG[leg].label} (${LEG_CONFIG[leg].currency})`).join(", ")}
        </span>
        {canCreate && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-500">
            Destination
            <input
              value={destCountry}
              onChange={(e) => setDestCountry(e.target.value.toUpperCase())}
              placeholder="e.g. BR"
              maxLength={3}
              className="w-16 bg-white border border-gray-300 rounded px-2 py-1 text-xs font-mono uppercase text-gray-900 focus:border-echo-orange focus:outline-none"
              title="Destination country code — drives country-specific invoice rules (e.g. Brazil folds packing + shipping into the product line)."
            />
          </span>
        )}
      </div>

      {error && <p className="text-xs text-amber-700 mb-2">{error}</p>}

      {containers.length === 0 ? (
        <p className="text-xs text-gray-400">No containers in transit to invoice.</p>
      ) : (
        <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                <th className="text-left font-medium px-3 py-2">Container</th>
                <th className="text-left font-medium px-3 py-2">PO ref</th>
                <th className="text-left font-medium px-3 py-2">Depots</th>
                <th className="text-right font-medium px-3 py-2">SKUs</th>
                <th className="text-right font-medium px-3 py-2">Units</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.container_ref} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-gray-900">{c.container_ref}</td>
                  <td className="px-3 py-2 font-mono text-gray-600">
                    {c.po_references.length === 0 ? (
                      <span className="text-amber-600" title="No PO reference on this container — the invoice can't tie back to a purchase order.">— no ref</span>
                    ) : c.po_references.length === 1 ? (
                      c.po_references[0]
                    ) : (
                      <span title={`This container carries ${c.po_references.length} POs: ${c.po_references.join(", ")}`}>
                        {c.po_references.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {c.depots.length > 0 ? (
                      <span className="font-mono">{c.depots.join(", ")}</span>
                    ) : (
                      <span className="text-amber-700">No depot</span>
                    )}
                    {unknownDepotNote(c) && (
                      <span className="block text-[10px] text-amber-700" data-testid="container-unknown-depot">
                        {unknownDepotNote(c)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{c.skus}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{c.units}</td>
                  <td className="px-3 py-2 text-right">
                    {canCreate ? (
                      <div className="flex items-center justify-end gap-1.5">
                        {c.legs.map((leg) => (
                          <button
                            key={leg}
                            onClick={() => generate(c.container_ref, leg)}
                            disabled={pending}
                            title={`${LEG_CONFIG[leg].label} (${LEG_CONFIG[leg].currency})`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {pending && busyRef === `${c.container_ref}:${leg}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                            {LEG_CONFIG[leg].currency}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-400">view only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <CommercialInvoiceModal doc={open.doc} warnings={open.warnings} onClose={() => setOpen(null)} />}
    </div>
  );
}
