"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, PackageOpen, FileText } from "lucide-react";
import { updateMaterialPrices } from "@/app/actions/bom/update-material-price";
import BamidaPoModal from "./bamida-po-modal";
import type { BamidaPo } from "@/lib/bamida-po";
import type { BomMasterRow, MaterialPrice, SroPoBom, SroPoBomLine } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";

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
}: Props) {
  const [tab, setTab] = useState<"orders" | "materials" | "master">("orders");

  return (
    <div>
      <div className="flex items-center bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-0.5 w-fit mb-5">
        {([
          ["orders", `SRO Order BOMs${orders.length ? ` (${orders.length})` : ""}`] as const,
          // Materials + BOM Prices are pricing views — cost.view only.
          ...(canViewCost ? [["materials", `Materials${materials.length ? ` (${materials.length})` : ""}`] as const] : []),
          ...(canViewCost ? [["master", "BOM Prices"] as const] : []),
        ]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={
              "px-4 py-1.5 rounded-md text-xs font-medium transition-colors " +
              (tab === k ? "bg-[#2a2a2a] text-[#e5e5e5]" : "text-[#6b7280] hover:text-[#9ca3af]")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "orders" && (
        <OrdersTab orders={orders} error={ordersError} canViewCost={canViewCost} bamidaByPo={bamidaByPo} />
      )}
      {tab === "materials" && canViewCost && (
        <MaterialsTab materials={materials} week={masterWeek} error={materialsError} canEdit={canEdit} />
      )}
      {tab === "master" && canViewCost && <MasterTab rows={master} week={masterWeek} error={masterError} />}
    </div>
  );
}

/* ----------------------------- Orders tab ------------------------------- */

function OrdersTab({ orders, error, canViewCost, bamidaByPo }: { orders: SroPoBom[]; error?: string; canViewCost: boolean; bamidaByPo: Record<string, BamidaPo> }) {
  if (error) return <Empty>{error}</Empty>;
  if (orders.length === 0) {
    return (
      <Empty>No approved EB&nbsp;SRO orders yet. Approve a purchase order and its BOM appears here automatically.</Empty>
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((po) => (
        <OrderCard key={po.id} po={po} canViewCost={canViewCost} bamida={bamidaByPo[po.id]} />
      ))}
    </div>
  );
}

function OrderCard({ po, canViewCost, bamida }: { po: SroPoBom; canViewCost: boolean; bamida: BamidaPo }) {
  const [open, setOpen] = useState(false);
  const [showBamida, setShowBamida] = useState(false);
  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl overflow-hidden">
      <div className="w-full flex items-center justify-between gap-4 px-5 py-4">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-3 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity">
          {open ? <ChevronDown className="w-4 h-4 text-[#6b7280] flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-[#6b7280] flex-shrink-0" />}
          <div className="min-w-0">
            <p className="font-mono text-[#FF7026] font-medium">{po.po_number}</p>
            <p className="text-xs text-[#6b7280] truncate">
              <span className="font-mono">{po.from_entity}</span> → <span className="font-mono">{po.to_entity}</span>
              {po.master_ref && <span className="text-[#4b5563]"> · {po.master_ref}</span>}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-5 flex-shrink-0 text-right">
          {canViewCost && (
            <>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#4b5563]">Bamida draft PO</p>
                <p className="text-sm font-bold tabular-nums text-[#FF7026]">{eur(po.bamida_total)}</p>
              </div>
              <div>
                <p
                  className="text-[10px] uppercase tracking-wider text-[#4b5563]"
                  title={po.cost_frozen && po.cost_snapshot_at ? `Frozen at approval on ${new Date(po.cost_snapshot_at).toLocaleDateString("en-GB")} — no longer changes when material prices are edited.` : undefined}
                >
                  SRO cost {po.cost_frozen ? "🔒 frozen" : "(live)"}
                </p>
                <p className="text-sm tabular-nums text-[#9ca3af]">{eur(po.sro_total)}</p>
              </div>
            </>
          )}
          <button
            onClick={() => setShowBamida(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#e5e5e5] bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#2a2a2a] rounded-lg transition-colors"
          >
            <FileText className="w-3.5 h-3.5" /> {canViewCost ? "Bamida PO" : "BOM PO"}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-[#2a2a2a] divide-y divide-[#222]">
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
          <span className="font-mono text-xs text-[#e5e5e5]">{line.sku}</span>
          {line.product_name && <span className="text-xs text-[#6b7280]">{line.product_name}</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#9ca3af]">×{line.quantity}</span>
          {line.model_code ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2a3a] border border-blue-900/40 text-blue-300 font-mono">{line.model_code}</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/20 border border-yellow-800/40 text-yellow-300">no BOM mapping</span>
          )}
        </div>
      </div>

      {line.has_bom ? (
        <>
          <div className="rounded-lg border border-[#222] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
                  <th className="text-left font-medium px-3 py-1.5">Component</th>
                  <th className="text-right font-medium px-3 py-1.5">Qty</th>
                  {canViewCost && <th className="text-right font-medium px-3 py-1.5">Unit €</th>}
                  {canViewCost && <th className="text-right font-medium px-3 py-1.5">Extended €</th>}
                  <th className="text-left font-medium px-3 py-1.5">Cur</th>
                </tr>
              </thead>
              <tbody>
                {line.components.map((c, i) => (
                  <tr key={i} className="border-t border-[#222]">
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-[#e5e5e5]">{c.code}</span>
                      {c.desc && <span className="text-[#6b7280]"> — {c.desc}</span>}
                      {c.dutiable && <span className="ml-1 text-[9px] text-orange-300">dutiable</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[#9ca3af]">{c.line_qty}</td>
                    {canViewCost && <td className="px-3 py-1.5 text-right tabular-nums text-[#6b7280]">{eur(c.unit_cost_eur)}</td>}
                    {canViewCost && <td className="px-3 py-1.5 text-right tabular-nums text-[#e5e5e5]">{eur(c.line_extended_eur)}</td>}
                    <td className="px-3 py-1.5 text-[#6b7280]">{c.currency ?? "EUR"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canViewCost && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-2 text-xs">
              <span className="text-[#6b7280]">Bamida man <span className="text-[#9ca3af] tabular-nums">{eur(line.bamida_man_eur * line.quantity)}</span></span>
              <span className="text-[#6b7280]">Bamida print <span className="text-[#9ca3af] tabular-nums">{eur(line.bamida_print_eur * line.quantity)}</span></span>
              <span className="text-[#6b7280]">Bamida PO line <span className="text-[#FF7026] font-bold tabular-nums">{eur(line.bamida_total_line)}</span></span>
              <span className="text-[#4b5563]">SRO cost (record) <span className="text-[#9ca3af] tabular-nums">{eur(line.sro_total_line)}</span></span>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-[#4b5563]">This SKU has no mapped BOM model (accessory or unmapped) — it carries no exploded components.</p>
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
  if (materials.length === 0) return <Empty>No materials found for the latest BOM week.</Empty>;

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
        return;
      }
      setMsg(
        `Updated ${res.updated} material price${res.updated === 1 ? "" : "s"}` +
          (res.missing ? ` (${res.missing} not found — refresh and retry)` : "") +
          ` — open “BOM Prices” to see the affected products.`
      );
      setDraft({});
      router.refresh();
    });
  }

  return (
    <>
      <p className="text-xs text-[#6b7280] mb-3">
        Edit a material price once — it applies to <span className="text-[#9ca3af]">every product</span> that uses it. Quantities (the recipe) come from the synced sheet and aren&apos;t editable here.
      </p>
      <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
              <th className="text-left font-medium px-4 py-2">Material</th>
              <th className="text-left font-medium px-4 py-2">Description</th>
              <th className="text-right font-medium px-4 py-2">Used in</th>
              <th className="text-right font-medium px-4 py-2">Unit price (€)</th>
              <th className="text-left font-medium px-4 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const v = draft[m.material_code] ?? String(m.unit_price_eur);
              const changed = dirty.some((d) => d.material_code === m.material_code);
              return (
                <tr key={m.material_code} className="border-t border-[#222] hover:bg-[#1a1a1a] transition-colors">
                  <td className="px-4 py-2 font-mono text-xs text-[#FF7026] font-medium">{m.material_code}</td>
                  <td className="px-4 py-2 text-xs text-[#9ca3af]">{m.description ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#6b7280]">{m.used_in_products}</td>
                  <td className="px-4 py-2 text-right">
                    {canEdit ? (
                      <>
                        <input
                          value={v}
                          onChange={(e) => setDraft((d) => ({ ...d, [m.material_code]: e.target.value }))}
                          inputMode="decimal"
                          aria-label={`price-${m.material_code}`}
                          className={inputCls + " tabular-nums text-right w-28 inline-block " + (changed ? "border-[#FF7026]" : "")}
                        />
                        {changed && <span className="block text-[10px] text-[#6b7280] mt-0.5">was {eur(m.unit_price_eur)}</span>}
                      </>
                    ) : (
                      <span className="tabular-nums text-[#e5e5e5]">{eur(m.unit_price_eur)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[10px] text-[#4b5563]">
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

      {msg && <p className="text-xs text-green-400 mt-3">{msg}</p>}
      {err && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2 mt-3">{err}</p>}

      {canEdit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-[10px] text-[#4b5563]">
            {dirty.length ? `${dirty.length} unsaved change${dirty.length === 1 ? "" : "s"}` : `Master prices · week of ${week ?? "—"}`}
          </span>
          <button
            onClick={save}
            disabled={pending || !dirty.length}
            className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save material prices
          </button>
        </div>
      )}
    </>
  );
}

/* --------------------------- BOM Prices tab (view) ----------------------- */

function MasterTab({ rows, week, error }: { rows: BomMasterRow[]; week: string | null; error?: string }) {
  if (error) return <Empty>{error}</Empty>;
  if (rows.length === 0) return <Empty>No BOM rows for the latest week.</Empty>;

  return (
    <>
      <p className="text-xs text-[#6b7280] mb-3">
        Per-product BOM totals priced from the material master. <span className="text-[#9ca3af]">Δ vs sheet</span> shows the change since the last synced snapshot — i.e. the effect of your material-price edits.
      </p>
      <div className="rounded-xl border border-[#2a2a2a] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
              <th className="text-left font-medium px-4 py-2">Model</th>
              <th className="text-left font-medium px-4 py-2">Line</th>
              <th className="text-right font-medium px-4 py-2">Components</th>
              <th className="text-right font-medium px-4 py-2">Bamida €</th>
              <th className="text-right font-medium px-4 py-2">SRO €</th>
              <th className="text-right font-medium px-4 py-2">BOM Total €</th>
              <th className="text-right font-medium px-4 py-2">Δ vs sheet</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = r.original_bom_total_eur != null && r.bom_total_eur != null ? r.bom_total_eur - r.original_bom_total_eur : null;
              return (
                <tr key={r.model_code} className="border-t border-[#222] hover:bg-[#1a1a1a] transition-colors">
                  <td className="px-4 py-2 font-mono text-xs text-[#FF7026] font-medium">{r.model_code}</td>
                  <td className="px-4 py-2 text-xs text-[#9ca3af]">{r.product_line ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#6b7280]">{r.component_detail.length}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#e5e5e5]">{eur(r.bamida_total_eur)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#e5e5e5]">{eur(r.sro_total_eur)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-bold text-[#FF7026]">{eur(r.bom_total_eur)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {delta == null || Math.abs(delta) < 0.005 ? (
                      <span className="text-[#4b5563]">—</span>
                    ) : (
                      <span className={delta > 0 ? "text-red-400" : "text-green-400"}>
                        {delta > 0 ? "+" : ""}
                        {delta.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#4b5563] mt-2">
        Prices come from the Hub material master (week of {week ?? "—"}); the SRO PO explosions read it live.
      </p>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-[#2a2a2a] rounded-xl p-12 text-center">
      <PackageOpen className="w-7 h-7 text-[#3a3a3a] mx-auto mb-3" />
      <p className="text-[#9ca3af] text-sm">{children}</p>
    </div>
  );
}
