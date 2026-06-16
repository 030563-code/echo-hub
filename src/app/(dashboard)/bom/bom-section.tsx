"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Loader2, X, PackageOpen } from "lucide-react";
import { updateBomComponentDetail } from "@/app/actions/bom/update-bom";
import type { BomMasterRow, SroPoBom, SroPoBomLine } from "@/lib/erp-types";

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";

const eur = (v: number | null | undefined) =>
  v == null ? "—" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Props {
  orders: SroPoBom[];
  ordersError?: string;
  master: BomMasterRow[];
  masterWeek: string | null;
  masterError?: string;
  canEdit: boolean;
}

export default function BomSection({ orders, ordersError, master, masterWeek, masterError, canEdit }: Props) {
  const [tab, setTab] = useState<"orders" | "master">("orders");

  return (
    <div>
      <div className="flex items-center bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-0.5 w-fit mb-5">
        {([
          ["orders", `SRO Order BOMs${orders.length ? ` (${orders.length})` : ""}`],
          ["master", "Master Prices"],
        ] as const).map(([k, label]) => (
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

      {tab === "orders" ? (
        <OrdersTab orders={orders} error={ordersError} />
      ) : (
        <MasterTab rows={master} week={masterWeek} error={masterError} canEdit={canEdit} />
      )}
    </div>
  );
}

/* ----------------------------- Orders tab ------------------------------- */

function OrdersTab({ orders, error }: { orders: SroPoBom[]; error?: string }) {
  if (error) {
    return <Empty>{error}</Empty>;
  }
  if (orders.length === 0) {
    return (
      <Empty>
        No approved EB&nbsp;SRO orders yet. Approve a purchase order and its BOM appears here automatically.
      </Empty>
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((po) => (
        <OrderCard key={po.id} po={po} />
      ))}
    </div>
  );
}

function OrderCard({ po }: { po: SroPoBom }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[#1a1a1a] transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          {open ? (
            <ChevronDown className="w-4 h-4 text-[#6b7280] flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[#6b7280] flex-shrink-0" />
          )}
          <div className="min-w-0">
            <p className="font-mono text-[#FF7026] font-medium">{po.po_number}</p>
            <p className="text-xs text-[#6b7280] truncate">
              <span className="font-mono">{po.from_entity}</span> → <span className="font-mono">{po.to_entity}</span>
              {po.master_ref && <span className="text-[#4b5563]"> · {po.master_ref}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5 flex-shrink-0 text-right">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[#4b5563]">Bamida draft PO</p>
            <p className="text-sm font-bold tabular-nums text-[#FF7026]">{eur(po.bamida_total)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[#4b5563]">SRO cost (record)</p>
            <p className="text-sm tabular-nums text-[#9ca3af]">{eur(po.sro_total)}</p>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-[#2a2a2a] divide-y divide-[#222]">
          {po.lines.map((l, i) => (
            <LineExplosion key={i} line={l} />
          ))}
        </div>
      )}
    </div>
  );
}

function LineExplosion({ line }: { line: SroPoBomLine }) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[#e5e5e5]">{line.sku}</span>
          {line.product_name && <span className="text-xs text-[#6b7280]">{line.product_name}</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#9ca3af]">×{line.quantity}</span>
          {line.model_code ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2a3a] border border-blue-900/40 text-blue-300 font-mono">
              {line.model_code}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/20 border border-yellow-800/40 text-yellow-300">
              no BOM mapping
            </span>
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
                  <th className="text-right font-medium px-3 py-1.5">Unit €</th>
                  <th className="text-right font-medium px-3 py-1.5">Extended €</th>
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
                    <td className="px-3 py-1.5 text-right tabular-nums text-[#6b7280]">{eur(c.unit_cost_eur)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[#e5e5e5]">{eur(c.line_extended_eur)}</td>
                    <td className="px-3 py-1.5 text-[#6b7280]">{c.currency ?? "EUR"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-2 text-xs">
            <span className="text-[#6b7280]">
              Bamida man <span className="text-[#9ca3af] tabular-nums">{eur(line.bamida_man_eur * line.quantity)}</span>
            </span>
            <span className="text-[#6b7280]">
              Bamida print{" "}
              <span className="text-[#9ca3af] tabular-nums">{eur(line.bamida_print_eur * line.quantity)}</span>
            </span>
            <span className="text-[#6b7280]">
              Bamida PO line <span className="text-[#FF7026] font-bold tabular-nums">{eur(line.bamida_total_line)}</span>
            </span>
            <span className="text-[#4b5563]">
              SRO cost (record) <span className="text-[#9ca3af] tabular-nums">{eur(line.sro_total_line)}</span>
            </span>
          </div>
        </>
      ) : (
        <p className="text-xs text-[#4b5563]">
          This SKU has no mapped BOM model (accessory or unmapped) — it carries no exploded components.
        </p>
      )}
    </div>
  );
}

/* ----------------------------- Master tab ------------------------------- */

function MasterTab({
  rows,
  week,
  error,
  canEdit,
}: {
  rows: BomMasterRow[];
  week: string | null;
  error?: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<BomMasterRow | null>(null);

  if (error) return <Empty>{error}</Empty>;
  if (rows.length === 0) return <Empty>No BOM master rows for the latest week.</Empty>;

  return (
    <>
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
              {canEdit && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model_code} className="border-t border-[#222] hover:bg-[#1a1a1a] transition-colors">
                <td className="px-4 py-2 font-mono text-xs text-[#FF7026] font-medium">{r.model_code}</td>
                <td className="px-4 py-2 text-xs text-[#9ca3af]">{r.product_line ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums text-[#6b7280]">{r.component_detail.length}</td>
                <td className="px-4 py-2 text-right tabular-nums text-[#e5e5e5]">{eur(r.bamida_total_eur)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-[#e5e5e5]">{eur(r.sro_total_eur)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-bold text-[#FF7026]">{eur(r.bom_total_eur)}</td>
                {canEdit && (
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setEditing(r)}
                      className="inline-flex items-center gap-1 text-xs text-[#9ca3af] hover:text-[#FF7026] transition-colors"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#4b5563] mt-2">
        Editing saves to the master BOM (week of {week ?? "—"}); PO explosions read it live.
      </p>

      {editing && <EditModal row={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/* ----------------------------- Edit modal ------------------------------- */

interface CompRow {
  code: string;
  desc: string;
  qty: string;
  unit_cost_eur: string;
  currency: string;
  dutiable: boolean;
}

function EditModal({ row, onClose }: { row: BomMasterRow; onClose: () => void }) {
  const router = useRouter();
  const [comps, setComps] = useState<CompRow[]>(
    row.component_detail.map((c) => ({
      code: c.code,
      desc: c.desc ?? "",
      qty: String(c.qty ?? 0),
      unit_cost_eur: String(c.unit_cost_eur ?? 0),
      currency: c.currency ?? "EUR",
      dutiable: Boolean(c.dutiable),
    }))
  );
  const [bamidaMan, setBamidaMan] = useState(String(row.bamida_man_eur ?? 0));
  const [bamidaPrint, setBamidaPrint] = useState(String(row.bamida_print_eur ?? 0));
  const [sroComponents, setSroComponents] = useState(String(row.sro_components_eur ?? 0));
  const [sroDuty, setSroDuty] = useState(String(row.sro_duty_8pct_eur ?? 0));
  const [sroAdmin, setSroAdmin] = useState(String(row.sro_admin_eur ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totals = useMemo(() => {
    const n = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
    const compExt = comps.reduce((s, c) => s + n(c.unit_cost_eur) * n(c.qty), 0);
    const bamidaTotal = n(bamidaMan) + n(bamidaPrint);
    const sroTotal = n(sroComponents) + n(sroDuty) + n(sroAdmin);
    return {
      compExt,
      bamidaTotal,
      sroTotal,
      bamidaPo: compExt + bamidaTotal,
      bomTotal: bamidaTotal + sroTotal,
    };
  }, [comps, bamidaMan, bamidaPrint, sroComponents, sroDuty, sroAdmin]);

  function setComp(i: number, patch: Partial<CompRow>) {
    setComps((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addComp() {
    setComps((prev) => [...prev, { code: "", desc: "", qty: "1", unit_cost_eur: "0", currency: "EUR", dutiable: false }]);
  }
  function removeComp(i: number) {
    setComps((prev) => prev.filter((_, idx) => idx !== i));
  }

  function save() {
    setError(null);
    const n = (s: string) => Number(s);
    if (comps.some((c) => !c.code.trim())) {
      setError("Every component needs a code.");
      return;
    }
    if (comps.some((c) => !Number.isFinite(n(c.qty)) || !Number.isFinite(n(c.unit_cost_eur)))) {
      setError("Quantities and unit costs must be numbers.");
      return;
    }
    startTransition(async () => {
      const res = await updateBomComponentDetail({
        modelCode: row.model_code,
        components: comps.map((c) => ({
          code: c.code.trim(),
          desc: c.desc.trim() || null,
          qty: n(c.qty),
          unit_cost_eur: n(c.unit_cost_eur),
          currency: c.currency.trim() || "EUR",
          dutiable: c.dutiable,
        })),
        bamida_man_eur: n(bamidaMan),
        bamida_print_eur: n(bamidaPrint),
        sro_components_eur: n(sroComponents),
        sro_duty_8pct_eur: n(sroDuty),
        sro_admin_eur: n(sroAdmin),
      });
      if (res.success) {
        router.refresh();
        onClose();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
              Edit BOM — <span className="font-mono text-[#FF7026]">{row.model_code}</span>
            </Dialog.Title>
            <Dialog.Close className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-xs text-[#6b7280] mb-4">
            Week of {row.week_start_date}. Saves to the master snapshot — every PO explosion updates.
          </p>

          {/* Components */}
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-[#e5e5e5]">Components</p>
            <button
              type="button"
              onClick={addComp}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#FF7026] hover:bg-[#FF7026]/10 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add component
            </button>
          </div>
          <div className="hidden sm:grid grid-cols-[1fr_1.4fr_70px_90px_70px_50px_28px] gap-2 px-1 mb-1">
            {["Code", "Description", "Qty", "Unit €", "Cur", "Duty", ""].map((h, i) => (
              <span key={i} className="text-[10px] uppercase tracking-wider text-[#4b5563]">
                {h}
              </span>
            ))}
          </div>
          <div className="space-y-2">
            {comps.map((c, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1.4fr_70px_90px_70px_50px_28px] gap-2">
                <input value={c.code} onChange={(e) => setComp(i, { code: e.target.value })} placeholder="code" className={inputCls + " font-mono"} />
                <input value={c.desc} onChange={(e) => setComp(i, { desc: e.target.value })} placeholder="description" className={inputCls} />
                <input value={c.qty} onChange={(e) => setComp(i, { qty: e.target.value })} inputMode="decimal" className={inputCls + " tabular-nums"} />
                <input value={c.unit_cost_eur} onChange={(e) => setComp(i, { unit_cost_eur: e.target.value })} inputMode="decimal" className={inputCls + " tabular-nums"} />
                <input value={c.currency} onChange={(e) => setComp(i, { currency: e.target.value })} className={inputCls} />
                <label className="flex items-center justify-center">
                  <input type="checkbox" checked={c.dutiable} onChange={(e) => setComp(i, { dutiable: e.target.checked })} className="accent-[#FF7026]" />
                </label>
                <button type="button" onClick={() => removeComp(i)} className="flex items-center justify-center text-[#6b7280] hover:text-red-400 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          {/* Cost inputs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-5">
            <CostField label="Bamida man €" value={bamidaMan} onChange={setBamidaMan} />
            <CostField label="Bamida print €" value={bamidaPrint} onChange={setBamidaPrint} />
            <div />
            <CostField label="SRO components €" value={sroComponents} onChange={setSroComponents} />
            <CostField label="SRO duty (8%) €" value={sroDuty} onChange={setSroDuty} />
            <CostField label="SRO admin €" value={sroAdmin} onChange={setSroAdmin} />
          </div>

          {/* Computed */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5 text-xs">
            <Computed label="Components €" value={totals.compExt} />
            <Computed label="Bamida draft PO €" value={totals.bamidaPo} accent />
            <Computed label="SRO total €" value={totals.sroTotal} />
            <Computed label="BOM total €" value={totals.bomTotal} accent />
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2 mt-4">{error}</p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close className="px-4 py-2 text-sm text-[#9ca3af] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
              Cancel
            </Dialog.Close>
            <button
              onClick={save}
              disabled={pending}
              className="inline-flex items-center gap-2 px-5 py-2 bg-[#FF7026] hover:bg-[#f2641b] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save to master
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CostField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-[#4b5563] mb-1">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className={inputCls + " tabular-nums"} />
    </div>
  );
}

function Computed({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-[#4b5563]">{label}</p>
      <p className={"tabular-nums font-bold " + (accent ? "text-[#FF7026]" : "text-[#e5e5e5]")}>{eur(value)}</p>
    </div>
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
