"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, PackageOpen, FileText, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchBox } from "@/components/ui/search-box";
import { updateMaterialPrices } from "@/app/actions/bom/update-material-price";
import { recostSroOrder } from "@/app/actions/bom/recost-sro-order";
import BamidaPoModal from "./bamida-po-modal";
import BomPricesTab from "./bom-prices-tab";
import ProductCodesTab from "./product-codes-tab";
import { entityLabel } from "@/lib/depot-constants";
import type { BamidaPo } from "@/lib/bamida-po";
import type { BomMasterRow, MaterialPrice, SroPoBom, SroPoBomLine } from "@/lib/erp-types";
import type { ProductModelRow } from "@/lib/sku-model";
import { usePersistedView, usePageState } from "@/hooks/use-page-state";
import { DraftStrip } from "@/components/page-state/draft-strip";
import {
  BOM_MATERIAL_PRICES_KEY,
  parseBomView,
  parseMaterialPriceDraft,
  parseSearchView,
  type BomView,
  type MaterialPriceDraft,
  type SearchView,
} from "@/lib/page-drafts";

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

const eur = (v: number | null | undefined) =>
  v == null ? "—" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const round4 = (v: number) => Math.round(v * 10000) / 10000;

interface Props {
  orders: SroPoBom[];
  ordersError?: string;
  master: BomMasterRow[];
  masterWeek: string | null;
  masterError?: string;
  materials: MaterialPrice[];
  materialsError?: string;
  canEdit: boolean;
  canViewCost: boolean;
  bamidaByPo: Record<string, BamidaPo>;
  products: ProductModelRow[];
  productsError?: string;
  /** Every model in the latest week of the bill of materials, for the Product codes tab. */
  bomModels: string[];
  /** Orders that can still be re-costed: approved, with no manufacturing order raised under them. */
  recostableIds: string[];
}

export default function BomSection({
  orders,
  ordersError,
  master,
  masterWeek,
  masterError,
  materials,
  materialsError,
  canEdit,
  canViewCost,
  bamidaByPo,
  products,
  productsError,
  bomModels,
  recostableIds,
}: Props) {
  // Which tab, remembered. The materials search box below has its OWN key
  // because it lives inside MaterialsTab: one row per call site, or the two
  // would overwrite each other's shape on every keystroke.
  const [bomView, setBomView] = usePersistedView<BomView>(
    "bom",
    { v: 1, tab: "orders", q: "" },
    parseBomView,
  );
  const tab = bomView.tab;
  const setTab = (next: BomView["tab"]) => setBomView({ ...bomView, tab: next });

  return (
    <div>
      <div className="flex items-center bg-gray-100 border border-gray-200 rounded-lg p-0.5 w-fit mb-5">
        {([
          ["orders", `SRO Order BOMs${orders.length ? ` (${orders.length})` : ""}`] as const,
          // Materials + BOM Prices are pricing views — cost.view only.
          ...(canViewCost ? [["materials", `Materials${materials.length ? ` (${materials.length})` : ""}`] as const] : []),
          ...(canViewCost ? [["master", "BOM Prices"] as const] : []),
          ["products", `Product codes${products.some((p) => !p.hasBom) ? ` (${products.filter((p) => !p.hasBom).length} to look at)` : ""}`] as const,
        ]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={
              "px-4 py-2.5 sm:py-1.5 rounded-md text-xs font-medium transition-colors " +
              (tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "orders" && (
        <OrdersTab
          orders={orders}
          error={ordersError}
          canViewCost={canViewCost}
          bamidaByPo={bamidaByPo}
          recostable={canEdit ? new Set(recostableIds) : new Set()}
        />
      )}
      {tab === "materials" && canViewCost && (
        <MaterialsTab materials={materials} week={masterWeek} error={materialsError} canEdit={canEdit} />
      )}
      {tab === "master" && canViewCost && <BomPricesTab rows={master} week={masterWeek} error={masterError} canEdit={canEdit} />}
      {tab === "products" && <ProductCodesTab rows={products} bomModels={bomModels} error={productsError} canEdit={canEdit} />}
    </div>
  );
}

/* ----------------------------- Orders tab ------------------------------- */

function OrdersTab({
  orders,
  error,
  canViewCost,
  bamidaByPo,
  recostable,
}: {
  orders: SroPoBom[];
  error?: string;
  canViewCost: boolean;
  bamidaByPo: Record<string, BamidaPo>;
  recostable: ReadonlySet<string>;
}) {
  if (error) return <Empty>{error}</Empty>;
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<PackageOpen className="w-7 h-7" />}
        title="No approved SRO order BOMs yet"
        description="Approve a purchase order and its BOM appears here automatically."
      />
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((po) => (
        <OrderCard key={po.id} po={po} canViewCost={canViewCost} bamida={bamidaByPo[po.id]} recostable={recostable.has(po.id)} />
      ))}
    </div>
  );
}

function OrderCard({ po, canViewCost, bamida, recostable }: { po: SroPoBom; canViewCost: boolean; bamida: BamidaPo; recostable: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showBamida, setShowBamida] = useState(false);
  const [recosting, startRecost] = useTransition();
  const uncosted = po.lines.filter((l) => !l.has_bom).length;

  function recost() {
    if (
      !window.confirm(
        `Re-cost ${po.po_number} from today's bill of materials and Bamida prices?\n\n` +
          `The cost it froze at approval is replaced. Nothing is sent to Xero or the factory.`,
      )
    )
      return;
    startRecost(async () => {
      const res = await recostSroOrder({ poId: po.id });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.poNumber} re-costed`);
      router.refresh();
    });
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="w-full flex items-center justify-between gap-4 px-5 py-4">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-3 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity">
          {open ? <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />}
          <div className="min-w-0">
            <p className="font-mono text-echo-orange font-medium">{po.po_number}</p>
            <p className="text-xs text-gray-500 truncate">
              <span>{entityLabel(po.from_entity)}</span> → <span>{entityLabel(po.to_entity)}</span>
              {po.master_ref && <span className="text-gray-400"> · {po.master_ref}</span>}
            </p>
            {uncosted > 0 && (
              <p className="text-[10px] text-amber-700 mt-0.5">
                {uncosted} line{uncosted === 1 ? "" : "s"} had no bill of materials when this was costed
                {recostable ? ": re-cost to try again with today's product codes" : ""}
              </p>
            )}
          </div>
        </button>
        <div className="flex items-center gap-5 flex-shrink-0 pl-7 sm:pl-0 text-left sm:text-right">
          {canViewCost && (
            <>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-400">Bamida draft PO</p>
                <p className="text-sm font-bold tabular-nums text-echo-orange">{eur(po.bamida_total)}</p>
              </div>
              <div>
                <p
                  className="text-[10px] uppercase tracking-wider text-gray-400"
                  title={po.cost_frozen && po.cost_snapshot_at ? `Frozen at approval on ${new Date(po.cost_snapshot_at).toLocaleDateString("en-GB")} — no longer changes when material prices are edited.` : undefined}
                >
                  SRO cost {po.cost_frozen ? "🔒 frozen" : "(live)"}
                </p>
                <p className="text-sm tabular-nums text-gray-600">{eur(po.sro_total)}</p>
              </div>
            </>
          )}
          {recostable && (
            <button
              onClick={recost}
              disabled={recosting}
              title="Freeze this order's cost again from today's bill of materials and Bamida prices"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-900 bg-gray-50 hover:bg-gray-100 border border-gray-300 rounded-lg transition-colors disabled:opacity-50"
            >
              {recosting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Re-cost
            </button>
          )}
          <button
            onClick={() => setShowBamida(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-900 bg-gray-50 hover:bg-gray-100 border border-gray-300 rounded-lg transition-colors"
          >
            <FileText className="w-3.5 h-3.5" /> {canViewCost ? "Bamida PO" : "BOM PO"}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-200 divide-y divide-gray-100">
          {po.lines.map((l, i) => (
            <LineExplosion key={i} line={l} canViewCost={canViewCost} />
          ))}
        </div>
      )}

      {showBamida && bamida && <BamidaPoModal bamida={bamida} onClose={() => setShowBamida(false)} />}
    </div>
  );
}

function LineExplosion({ line, canViewCost }: { line: SroPoBomLine; canViewCost: boolean }) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-900">{line.sku}</span>
          {line.product_name && <span className="text-xs text-gray-500">{line.product_name}</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">×{line.quantity}</span>
          {line.model_code ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800 font-mono">{line.model_code}</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">no BOM mapping</span>
          )}
          {line.bom_model_code && line.bom_model_code !== line.model_code && (
            <span className="text-[10px] text-gray-500">
              costed as <span className="font-mono text-gray-700">{line.bom_model_code}</span>
            </span>
          )}
        </div>
      </div>

      {line.has_bom ? (
        <>
          <div className="rounded-lg border border-gray-100 overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="text-left font-medium px-3 py-1.5">Component</th>
                  <th className="text-right font-medium px-3 py-1.5">Qty</th>
                  {canViewCost && <th className="text-right font-medium px-3 py-1.5">Unit €</th>}
                  {canViewCost && <th className="text-right font-medium px-3 py-1.5">Extended €</th>}
                  <th className="text-left font-medium px-3 py-1.5">Cur</th>
                </tr>
              </thead>
              <tbody>
                {line.components.map((c, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-gray-900">{c.code}</span>
                      {c.desc && <span className="text-gray-500"> — {c.desc}</span>}
                      {c.dutiable && <span className="ml-1 text-[9px] text-orange-700">dutiable</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{c.line_qty}</td>
                    {canViewCost && <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(c.unit_cost_eur)}</td>}
                    {canViewCost && <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{eur(c.line_extended_eur)}</td>}
                    <td className="px-3 py-1.5 text-gray-500">{c.currency ?? "EUR"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canViewCost && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-2 text-xs">
              <span className="text-gray-500">Bamida man <span className="text-gray-600 tabular-nums">{eur(line.bamida_man_eur * line.quantity)}</span></span>
              <span className="text-gray-500">Bamida print <span className="text-gray-600 tabular-nums">{eur(line.bamida_print_eur * line.quantity)}</span></span>
              <span className="text-gray-500">Bamida PO line <span className="text-echo-orange font-bold tabular-nums">{eur(line.bamida_total_line)}</span></span>
              <span className="text-gray-400">SRO cost (record) <span className="text-gray-600 tabular-nums">{eur(line.sro_total_line)}</span></span>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-gray-400">
          No bill of materials{(line.bom_model_code ?? line.model_code) ? ` for ${line.bom_model_code ?? line.model_code}` : ""} when this cost was
          worked out, so the line carries no materials{canViewCost ? " and no Bamida prices" : ""}. The Product codes tab says what each code is
          costed as.
        </p>
      )}
    </div>
  );
}

/* --------------------------- Materials tab (edit) ------------------------ */

function MaterialsTab({ materials, week, error, canEdit }: { materials: MaterialPrice[]; week: string | null; error?: string; canEdit: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Typed prices that have not been committed yet.
  //
  // Fingerprinted on the BOM week, and DISCARDED rather than restored when the
  // week has rolled over: these numbers reprice every product that uses the
  // material, so putting last week's typing back on this week's list is the one
  // restore here that could quietly cost money.
  const {
    restored: restoredPrices,
    save: savePrices,
    clear: clearPrices,
    saveStatus: pricesSaveStatus,
    savedAt: pricesSavedAt,
  } = usePageState<MaterialPriceDraft>({
    pageKey: BOM_MATERIAL_PRICES_KEY,
    parse: parseMaterialPriceDraft,
    base: week ?? null,
    enabled: canEdit,
    onRestore: (restored) => {
      if (!restored || restored.stale) {
        if (restored?.stale) void clearPrices();
        return;
      }
      setDraft(restored.data.prices);
    },
    isEmpty: (d) => Object.keys(d.prices).length === 0,
  });

  useEffect(() => {
    if (!canEdit) return;
    savePrices({ v: 1, prices: draft });
  }, [canEdit, savePrices, draft]);
  const [qView, setQView] = usePersistedView<SearchView>(
    "bom:materials",
    { v: 1, q: "" },
    parseSearchView,
  );
  const q = qView.q;
  const setQ = (next: string) => setQView({ v: 1, q: next });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return materials;
    return materials.filter((m) => (m.material_code + " " + (m.description ?? "")).toLowerCase().includes(needle));
  }, [q, materials]);

  const dirty = useMemo(() => {
    const out: { material_code: string; unit_price_eur: number }[] = [];
    for (const m of materials) {
      const v = draft[m.material_code];
      if (v === undefined) continue;
      const n = Number(v);
      // Compare at the server's 4dp precision so a no-op re-type isn't "dirty".
      if (v.trim() !== "" && Number.isFinite(n) && n >= 0 && round4(n) !== m.unit_price_eur) {
        out.push({ material_code: m.material_code, unit_price_eur: n });
      }
    }
    return out;
  }, [draft, materials]);

  if (error) return <Empty>{error}</Empty>;
  if (materials.length === 0)
    return (
      <EmptyState
        icon={<PackageOpen className="w-7 h-7" />}
        title="No materials"
        description="No materials found for the latest BOM week."
      />
    );

  function save() {
    setErr(null);
    setMsg(null);
    if (!dirty.length) return;
    // A material price ripples to every product that uses it — confirm the change
    // + blast radius before committing, so a fat-finger (1.50 → 150) can't silently
    // reprice dozens of BOMs.
    const affected = dirty.reduce((sum, d) => {
      const m = materials.find((x) => x.material_code === d.material_code);
      return sum + (m?.used_in_products ?? 0);
    }, 0);
    const summary = dirty
      .map((d) => {
        const m = materials.find((x) => x.material_code === d.material_code);
        return `• ${d.material_code}: ${m ? eur(m.unit_price_eur) : "?"} → ${eur(d.unit_price_eur)}`;
      })
      .join("\n");
    if (
      !window.confirm(
        `Save ${dirty.length} material price change${dirty.length === 1 ? "" : "s"}?\n\n${summary}\n\nThis reprices ~${affected} product line${affected === 1 ? "" : "s"} across all BOMs.`
      )
    )
      return;
    startTransition(async () => {
      const res = await updateMaterialPrices({ edits: dirty });
      if (!res.success) {
        setErr(res.error);
        toast.error(res.error);
        return;
      }
      setMsg(
        `Updated ${res.updated} material price${res.updated === 1 ? "" : "s"}` +
          (res.missing ? ` (${res.missing} not found — refresh and retry)` : "") +
          ` — open “BOM Prices” to see the affected products.`
      );
      toast.success(
        `Updated ${res.updated} material price${res.updated === 1 ? "" : "s"}` +
          (res.missing ? ` (${res.missing} not found)` : "")
      );
      setDraft({});
      // The prices are committed, so the typing behind them is spent.
      void clearPrices();
      router.refresh();
    });
  }

  return (
    <>
      {restoredPrices && (
        <div className="mb-3">
          <DraftStrip
            what="the prices you had typed"
            savedAt={pricesSavedAt}
            onStartAgain={async () => {
              await clearPrices();
              setDraft({});
            }}
            startAgainLabel="Discard them"
            saveStatus={pricesSaveStatus}
          />
        </div>
      )}

      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-gray-500">
          Edit a material price once — it applies to <span className="text-gray-600">every product</span> that uses it. Quantities (the recipe) come from the synced sheet and aren&apos;t editable here.
        </p>
        <SearchBox value={q} onChange={setQ} placeholder="Search material or description…" className="flex-shrink-0" />
      </div>
      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <th className="text-left font-medium px-4 py-2">Material</th>
              <th className="text-left font-medium px-4 py-2">Description</th>
              <th className="text-right font-medium px-4 py-2">Used in</th>
              <th className="text-right font-medium px-4 py-2">Unit price (€)</th>
              <th className="text-left font-medium px-4 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                  No materials match “{q}”.
                </td>
              </tr>
            )}
            {filtered.map((m) => {
              const v = draft[m.material_code] ?? String(m.unit_price_eur);
              const changed = dirty.some((d) => d.material_code === m.material_code);
              return (
                <tr key={m.material_code} className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2 font-mono text-xs text-echo-orange font-medium">{m.material_code}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{m.description ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{m.used_in_products}</td>
                  <td className="px-4 py-2 text-right">
                    {canEdit ? (
                      <>
                        <input
                          value={v}
                          onChange={(e) => setDraft((d) => ({ ...d, [m.material_code]: e.target.value }))}
                          inputMode="decimal"
                          aria-label={`price-${m.material_code}`}
                          className={inputCls + " tabular-nums text-right w-28 inline-block " + (changed ? "border-echo-orange" : "")}
                        />
                        {changed && <span className="block text-[10px] text-gray-500 mt-0.5">was {eur(m.unit_price_eur)}</span>}
                      </>
                    ) : (
                      <span className="tabular-nums text-gray-900">{eur(m.unit_price_eur)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[10px] text-gray-400">
                    {m.updated_by_label
                      ? `${m.updated_by_label}${m.updated_at ? " · " + new Date(m.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {msg && <p className="text-xs text-green-700 mt-3">{msg}</p>}
      {err && <p className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{err}</p>}

      {canEdit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-[10px] text-gray-400">
            {dirty.length ? `${dirty.length} unsaved change${dirty.length === 1 ? "" : "s"}` : `Master prices · week of ${week ?? "—"}`}
          </span>
          <button
            onClick={save}
            disabled={pending || !dirty.length}
            className="inline-flex items-center gap-2 px-5 py-3 sm:py-2 bg-echo-orange hover:bg-echo-orange-hover disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save material prices
          </button>
        </div>
      )}
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-xl p-12 text-center">
      <PackageOpen className="w-7 h-7 text-gray-300 mx-auto mb-3" />
      <p className="text-gray-600 text-sm">{children}</p>
    </div>
  );
}
