"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Loader2, CheckCircle2 } from "lucide-react";
import { createPurchaseOrder } from "@/app/actions/purchase-orders/create-po";
import type { PoProductCatalogItem, PoDeliveryAddress, PoHsCode } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";
const selectCls = inputCls;

interface LineRow {
  sku: string;
  quantity: number;
  hs_code: string;
  unit_price: string;
}

const emptyLine = (): LineRow => ({ sku: "", quantity: 1, hs_code: "", unit_price: "" });

interface Props {
  depots: string[];
  catalog: PoProductCatalogItem[];
  addresses: PoDeliveryAddress[];
  hsCodes: PoHsCode[];
}

export default function RaisePOForm({ depots, catalog, addresses, hsCodes }: Props) {
  const router = useRouter();
  const [fromEntity, setFromEntity] = useState(depots[0] ?? "");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Group the catalogue by product family for the SKU <optgroup>s.
  const families = useMemo(() => {
    const map = new Map<string, PoProductCatalogItem[]>();
    for (const c of catalog) {
      const fam = c.product_family || "Other";
      if (!map.has(fam)) map.set(fam, []);
      map.get(fam)!.push(c);
    }
    return [...map.entries()];
  }, [catalog]);

  function updateLine(i: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!fromEntity) {
      setError("Select the raising depot.");
      return;
    }
    if (lines.some((l) => !l.sku)) {
      setError("Every line needs a product.");
      return;
    }
    if (lines.some((l) => !l.quantity || l.quantity < 1)) {
      setError("Every line needs a quantity of at least 1.");
      return;
    }

    const payloadLines = lines.map((l) => ({
      sku: l.sku,
      quantity: Number(l.quantity) || 0,
      hs_code: l.hs_code.trim() || undefined,
      unit_price: l.unit_price.trim() !== "" ? Number(l.unit_price) : undefined,
    }));

    startTransition(async () => {
      const res = await createPurchaseOrder({
        from_entity: fromEntity,
        delivery_address: deliveryAddress || undefined,
        notes: notes.trim() || undefined,
        lines: payloadLines,
      });
      if (res.success) {
        setSuccess(res.po_number);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (depots.length === 0) {
    return (
      <div className="border border-dashed border-[#2a2a2a] rounded-xl p-12 text-center">
        <p className="text-[#9ca3af] mb-1">No raising depot assigned to your account.</p>
        <p className="text-xs text-[#4b5563]">Ask an administrator to add a depot to your profile before raising a PO.</p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="border border-green-800/40 bg-green-900/10 rounded-xl p-8 text-center">
        <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
        <p className="text-white text-lg font-semibold" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Purchase order raised
        </p>
        <p className="text-[#9ca3af] text-sm mt-1">
          <span className="font-mono text-[#FF7026]">{success}</span> is now awaiting EB&nbsp;Group approval.
        </p>
        <div className="flex items-center justify-center gap-2 mt-5">
          <Link
            href="/purchase-orders"
            className="px-4 py-2 bg-[#FF7026] hover:bg-[#f2641b] text-white text-sm font-medium rounded-lg transition-colors"
          >
            View on the board
          </Link>
          <button
            onClick={() => {
              setSuccess(null);
              setLines([emptyLine()]);
              setNotes("");
              setDeliveryAddress("");
            }}
            className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors"
          >
            Raise another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header fields */}
      <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-[#9ca3af] mb-1">Raising depot *</label>
            <select required value={fromEntity} onChange={(e) => setFromEntity(e.target.value)} className={selectCls}>
              {depots.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-[#4b5563] mt-1">Raised to <span className="font-mono">EB-GROUP</span>.</p>
          </div>
          <div>
            <label className="block text-xs text-[#9ca3af] mb-1">Delivery address</label>
            <select value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} className={selectCls}>
              <option value="">Select a ship-to address…</option>
              {addresses.map((a) => (
                <option key={a.id} value={`${a.label}${a.address ? ` — ${a.address}` : ""}`}>
                  {a.label}
                  {a.address ? ` — ${a.address}` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-[#9ca3af] mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything EB Group should know about this order…"
            className={inputCls + " resize-none"}
          />
        </div>
      </div>

      {/* Line items */}
      <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-[#e5e5e5]">Line items</p>
          <button
            type="button"
            onClick={addLine}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#FF7026] hover:bg-[#FF7026]/10 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add line
          </button>
        </div>

        {/* Column headers */}
        <div className="hidden sm:grid grid-cols-[1fr_90px_120px_110px_36px] gap-2 px-1 mb-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#4b5563]">Product</span>
          <span className="text-[10px] uppercase tracking-wider text-[#4b5563]">Qty</span>
          <span className="text-[10px] uppercase tracking-wider text-[#4b5563]">HS code</span>
          <span className="text-[10px] uppercase tracking-wider text-[#4b5563]">Unit price</span>
          <span />
        </div>

        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_90px_120px_110px_36px] gap-2">
              <select
                value={line.sku}
                onChange={(e) => updateLine(i, { sku: e.target.value })}
                className={selectCls + " col-span-2 sm:col-span-1"}
              >
                <option value="">Select product…</option>
                {families.map(([fam, items]) => (
                  <optgroup key={fam} label={fam}>
                    {items.map((c) => (
                      <option key={c.sku} value={c.sku}>
                        {c.sku} — {c.product_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: parseInt(e.target.value, 10) || 1 })}
                className={inputCls + " tabular-nums"}
                aria-label="Quantity"
              />
              <input
                type="text"
                list="hs-code-list"
                value={line.hs_code}
                onChange={(e) => updateLine(i, { hs_code: e.target.value })}
                placeholder="optional"
                className={inputCls}
                aria-label="HS code"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={line.unit_price}
                onChange={(e) => updateLine(i, { unit_price: e.target.value })}
                placeholder="optional"
                className={inputCls + " tabular-nums"}
                aria-label="Unit price"
              />
              <button
                type="button"
                onClick={() => removeLine(i)}
                disabled={lines.length === 1}
                className="flex items-center justify-center text-[#6b7280] hover:text-red-400 disabled:opacity-30 disabled:hover:text-[#6b7280] transition-colors"
                aria-label="Remove line"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        <datalist id="hs-code-list">
          {hsCodes.map((h) => (
            <option key={h.code} value={h.code}>
              {h.description ?? h.code}
            </option>
          ))}
        </datalist>
      </div>

      {error && (
        <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Link
          href="/purchase-orders"
          className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {pending && <Loader2 className="w-4 h-4 animate-spin" />}
          Raise PO for approval
        </button>
      </div>
    </form>
  );
}
