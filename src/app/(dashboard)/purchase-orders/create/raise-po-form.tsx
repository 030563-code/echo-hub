"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Loader2, CheckCircle2, Save, Layers } from "lucide-react";
import { createPurchaseOrder } from "@/app/actions/purchase-orders/create-po";
import { saveTemplate, deleteTemplate } from "@/app/actions/purchase-orders/templates";
import { isLineShort } from "@/lib/po-stock";
import type { PoProductCatalogItem, PoDeliveryAddress, PoHsCode, ProductEntityCodes, PoTemplate } from "@/lib/erp-types";

// Which product_code_master column holds the Xero product code for each depot.
const DEPOT_CODE_COL: Record<string, keyof ProductEntityCodes> = {
  "US-BAL": "code_usa_balt",
  "US-SBD": "code_usa_sb",
  "CA-HAM": "code_canada",
};

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";
const selectCls = inputCls;

interface LineRow {
  sku: string;
  // Held as a free-text string so the field can be cleared/retyped; coerced to a
  // number only at submit. (Storing it as a number + `parseInt || 1` traps the
  // input on 1 — you can never delete the 1.)
  quantity: string;
  hs_code: string;
  unit_price: string;
}

const emptyLine = (): LineRow => ({ sku: "", quantity: "1", hs_code: "", unit_price: "" });

interface Props {
  depots: string[];
  catalog: PoProductCatalogItem[];
  addresses: PoDeliveryAddress[];
  hsCodes: PoHsCode[];
  entityCodes: ProductEntityCodes[];
  templates: PoTemplate[];
  /** SKU → total on-hand across warehouses (dummy until the stocktake lands). */
  stockBySku: Record<string, number>;
  /** cost.view holders may set/see unit prices; workers get a price-less form. */
  canViewCost: boolean;
}

export default function RaisePOForm({ depots, catalog, addresses, hsCodes, entityCodes, templates, stockBySku, canViewCost }: Props) {
  const router = useRouter();
  const [fromEntity, setFromEntity] = useState(depots[0] ?? "");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [templateId, setTemplateId] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplNotice, setTplNotice] = useState<string | null>(null);

  function applyTemplate(id: string) {
    setTemplateId(id);
    setTplNotice(null);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (t.from_entity && depots.includes(t.from_entity)) setFromEntity(t.from_entity);
    setDeliveryAddress(t.delivery_address ?? "");
    setNotes(t.notes ?? "");
    const tplLines = (t.lines ?? []).map((l) => ({
      sku: l.sku,
      quantity: String(l.quantity ?? 1),
      hs_code: l.hs_code ?? "",
      unit_price: l.unit_price != null ? String(l.unit_price) : "",
    }));
    setLines(tplLines.length ? tplLines : [emptyLine()]);
  }

  function saveAsTemplate() {
    setTplNotice(null);
    const name = window.prompt("Template name (e.g. 'Truck to Paris')")?.trim();
    if (!name) return;
    // Dedupe: a repeated name yields indistinguishable dropdown entries.
    if (templates.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) {
      if (!window.confirm(`A template named "${name}" already exists. Save another with the same name?`)) return;
    }
    const validLines = lines
      .filter((l) => l.sku && Number(l.quantity) > 0)
      .map((l) => ({
        sku: l.sku,
        quantity: Number(l.quantity),
        hs_code: l.hs_code.trim() || undefined,
        unit_price: l.unit_price.trim() !== "" ? Number(l.unit_price) : undefined,
      }));
    if (!validLines.length) {
      setTplNotice("Add at least one valid line before saving a template.");
      return;
    }
    setSavingTpl(true);
    startTransition(async () => {
      const res = await saveTemplate({
        name,
        from_entity: fromEntity || undefined,
        delivery_address: deliveryAddress || undefined,
        notes: notes.trim() || undefined,
        lines: validLines,
      });
      setSavingTpl(false);
      if (res.success) {
        setTplNotice(`Saved template "${name}".`);
        router.refresh();
      } else {
        setTplNotice(res.error);
      }
    });
  }

  function removeTemplate() {
    if (!templateId) return;
    const t = templates.find((x) => x.id === templateId);
    if (!t || !window.confirm(`Delete template "${t.name}"?`)) return;
    startTransition(async () => {
      const res = await deleteTemplate(templateId);
      if (res.success) {
        setTemplateId("");
        router.refresh();
      } else {
        setTplNotice(res.error ?? "Failed to delete template.");
      }
    });
  }

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

  // Resolve the selected depot's Xero product code for a catalogue SKU
  // (sku → internal_sku → product_code_master.code_<depot>).
  const skuToInternal = useMemo(() => new Map(catalog.map((c) => [c.sku, c.internal_sku])), [catalog]);
  const internalToCodes = useMemo(() => new Map(entityCodes.map((e) => [e.internal_sku, e])), [entityCodes]);
  const codeCol = DEPOT_CODE_COL[fromEntity];
  function depotCode(sku: string): string | null {
    const internal = skuToInternal.get(sku);
    if (!internal || !codeCol) return null;
    const v = internalToCodes.get(internal)?.[codeCol];
    return v ? String(v).trim() : null;
  }

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
    if (lines.some((l) => !Number.isFinite(Number(l.quantity)) || Number(l.quantity) < 1)) {
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
      {/* Templates — recurring-order autofill */}
      <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#6b7280]" />
          <select
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className={selectCls + " w-auto min-w-[200px]"}
          >
            <option value="">Load from template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templateId && (
            <button
              type="button"
              onClick={removeTemplate}
              className="p-1.5 text-[#6b7280] hover:text-red-400 transition-colors"
              title="Delete template"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={saveAsTemplate}
          disabled={savingTpl}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg transition-colors disabled:opacity-50"
        >
          {savingTpl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save as template
        </button>
        {tplNotice && <span className="text-xs text-[#6b7280]">{tplNotice}</span>}
      </div>

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
            <div key={i}>
              <div className="grid grid-cols-2 sm:grid-cols-[1fr_90px_120px_110px_36px] gap-2">
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
                inputMode="numeric"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                onBlur={(e) => {
                  // Normalise a left-empty field back to "1" so it never submits blank.
                  if (e.target.value.trim() === "") updateLine(i, { quantity: "1" });
                }}
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
              {canViewCost ? (
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
              ) : (
                <div className={inputCls + " tabular-nums text-[#4b5563] flex items-center"} aria-hidden="true">—</div>
              )}
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
              {line.sku && codeCol && (
                <p className="text-[10px] text-[#4b5563] mt-1 pl-1">
                  {fromEntity} Xero code:{" "}
                  {depotCode(line.sku) ? (
                    <span className="font-mono text-[#9ca3af]">{depotCode(line.sku)}</span>
                  ) : (
                    <span className="text-yellow-600/80">none mapped for {fromEntity}</span>
                  )}
                </p>
              )}
              {isLineShort({ sku: line.sku, quantity: Number(line.quantity) || 0 }, stockBySku) && (
                <p className="text-[10px] text-yellow-500/90 mt-1 pl-1">
                  ⚠ Stock short — ordered {Number(line.quantity) || 0}, {stockBySku[line.sku] ?? 0} on hand (does not block).
                </p>
              )}
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
