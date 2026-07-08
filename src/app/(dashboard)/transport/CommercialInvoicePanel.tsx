"use client";

import { useMemo, useState, useTransition } from "react";
import { FileText, Loader2 } from "lucide-react";
import type { ShipmentContent } from "@/lib/erp-types";
import type { CommercialInvoiceDoc } from "@/lib/commercial-invoice";
import { generateCommercialInvoice } from "@/app/actions/invoices/generate-commercial-invoice";
import CommercialInvoiceModal from "./CommercialInvoiceModal";

interface ContainerGroup {
  container_ref: string;
  skus: number;
  units: number;
  po_references: string[];
  spot_id: string | null;
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
  const [destCountry, setDestCountry] = useState("");

  const containers = useMemo<ContainerGroup[]>(() => {
    const byRef = new Map<string, { skus: Set<string>; units: number; pos: Set<string>; spot: string | null }>();
    for (const it of items) {
      if (!it.container_ref) continue;
      const g = byRef.get(it.container_ref) ?? { skus: new Set<string>(), units: 0, pos: new Set<string>(), spot: null };
      g.skus.add(it.sku);
      g.units += it.qty;
      if (it.po_reference) g.pos.add(it.po_reference);
      g.spot = g.spot ?? it.spot_id;
      byRef.set(it.container_ref, g);
    }
    return [...byRef.entries()]
      .map(([container_ref, g]) => ({ container_ref, skus: g.skus.size, units: g.units, po_references: [...g.pos].sort(), spot_id: g.spot }))
      .sort((a, b) => a.container_ref.localeCompare(b.container_ref));
  }, [items]);

  function generate(container_ref: string, leg: "SRO_TO_GROUP" | "GROUP_TO_USA") {
    setError(null);
    setBusyRef(`${container_ref}:${leg}`);
    startTransition(async () => {
      const res = await generateCommercialInvoice({ container_ref, leg, destination_country: destCountry.trim() || undefined });
      setBusyRef(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen({ doc: res.doc, warnings: res.warnings });
    });
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Commercial Invoices
        </h2>
        <span className="text-[10px] text-[#4b5563]">per container — EUR (SRO → Group) &amp; USD (Group → USA)</span>
        {canCreate && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[#6b7280]">
            Destination
            <input
              value={destCountry}
              onChange={(e) => setDestCountry(e.target.value.toUpperCase())}
              placeholder="e.g. BR"
              maxLength={3}
              className="w-16 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs font-mono uppercase text-[#e5e5e5] focus:border-[#FF7026] focus:outline-none"
              title="Destination country code — drives country-specific invoice rules (e.g. Brazil folds packing + shipping into the product line)."
            />
          </span>
        )}
      </div>

      {error && <p className="text-xs text-yellow-400 mb-2">{error}</p>}

      {containers.length === 0 ? (
        <p className="text-xs text-[#4b5563]">No containers in transit to invoice.</p>
      ) : (
        <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                <th className="text-left font-medium px-3 py-2">Container</th>
                <th className="text-left font-medium px-3 py-2">PO ref</th>
                <th className="text-right font-medium px-3 py-2">SKUs</th>
                <th className="text-right font-medium px-3 py-2">Units</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.container_ref} className="border-t border-[#222]">
                  <td className="px-3 py-2 font-mono text-[#e5e5e5]">{c.container_ref}</td>
                  <td className="px-3 py-2 font-mono text-[#9ca3af]">
                    {c.po_references.length === 0 ? (
                      <span className="text-yellow-500/80" title="No PO reference on this container — the invoice can't tie back to a purchase order.">— no ref</span>
                    ) : c.po_references.length === 1 ? (
                      c.po_references[0]
                    ) : (
                      <span title={`This container carries ${c.po_references.length} POs: ${c.po_references.join(", ")}`}>
                        {c.po_references.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#9ca3af]">{c.skus}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#9ca3af]">{c.units}</td>
                  <td className="px-3 py-2 text-right">
                    {canCreate ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => generate(c.container_ref, "SRO_TO_GROUP")}
                          disabled={pending}
                          title="SRO → Group (EUR)"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
                        >
                          {pending && busyRef === `${c.container_ref}:SRO_TO_GROUP` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                          EUR
                        </button>
                        <button
                          onClick={() => generate(c.container_ref, "GROUP_TO_USA")}
                          disabled={pending}
                          title="Group → USA (USD)"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
                        >
                          {pending && busyRef === `${c.container_ref}:GROUP_TO_USA` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                          USD
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-[#4b5563]">view only</span>
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
