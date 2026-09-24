"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, PackageOpen } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { DraftStrip } from "@/components/page-state/draft-strip";
import { usePageState } from "@/hooks/use-page-state";
import { saveBamidaPrices, type SaveBamidaPricesInput } from "@/app/actions/bom/bamida-prices";
import { BOM_BAMIDA_PRICES_KEY, parseBamidaPriceDraft, type BamidaPriceDraft } from "@/lib/page-drafts";
import type { BomMasterRow } from "@/lib/erp-types";

const inputCls =
  "px-2 py-1.5 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 focus:outline-none focus:border-echo-orange transition-colors tabular-nums text-right w-24";

const eur = (v: number | null | undefined) =>
  v == null ? "none" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** A price as a box shows it: two decimals, four where the price has them. */
const priceText = (v: number | null) => (v == null ? "" : v.toFixed(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9 ? 2 : 4));

type Part = "man" | "print";

const PART_LABEL: Record<Part, string> = { man: "manufacturing", print: "printing" };

/** What a part costs now, where it comes from, and what the sheet says. */
function current(row: BomMasterRow, part: Part) {
  const fromHub = part === "man" ? Boolean(row.hub_price?.manufacturing) : Boolean(row.hub_price?.printing);
  return {
    value: part === "man" ? row.bamida_man_eur : row.bamida_print_eur,
    sheet: part === "man" ? row.sheet_man_eur ?? null : row.sheet_print_eur ?? null,
    fromHub,
  };
}

interface Change {
  model: string;
  part: Part;
  /** The new price, or null for the sheet's. */
  to: number | null;
  from: number | null;
  fromHub: boolean;
  sheet: number | null;
}

/**
 * The BOM master priced from the material master, with Bamida's two prices
 * editable. They win over the sheet's until somebody hands a part back to it:
 * the weekly sync rewrites the sheet's copy every Monday, so a correction made
 * anywhere but here would last a week.
 */
export default function BomPricesTab({
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
  const router = useRouter();
  const [draft, setDraft] = useState<BamidaPriceDraft["prices"]>({});
  const [pending, startTransition] = useTransition();

  // Typed prices not saved yet. Fingerprinted on the BOM week and discarded
  // when it has rolled over, like the material prices: last week's typing on
  // this week's sheet is the one restore that could quietly cost money.
  const {
    restored,
    save: saveDraft,
    clear: clearDraft,
    saveStatus,
    savedAt,
  } = usePageState<BamidaPriceDraft>({
    pageKey: BOM_BAMIDA_PRICES_KEY,
    parse: parseBamidaPriceDraft,
    base: week ?? null,
    enabled: canEdit,
    onRestore: (r) => {
      if (!r || r.stale) {
        if (r?.stale) void clearDraft();
        return;
      }
      setDraft(r.data.prices);
    },
    isEmpty: (d) => Object.keys(d.prices).length === 0,
  });

  useEffect(() => {
    if (!canEdit) return;
    saveDraft({ v: 1, prices: draft });
  }, [canEdit, saveDraft, draft]);

  const { changes, invalid } = useMemo(() => {
    const out: Change[] = [];
    const bad: string[] = [];
    for (const row of rows) {
      const typed = draft[row.model_code];
      if (!typed) continue;
      for (const part of ["man", "print"] as const) {
        const t = typed[part];
        if (t === undefined) continue;
        const now = current(row, part);
        if (t === null) {
          if (now.fromHub) out.push({ model: row.model_code, part, to: null, from: now.value, fromHub: true, sheet: now.sheet });
          continue;
        }
        const n = Number(t);
        if (t.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100_000) {
          bad.push(`${row.model_code} ${PART_LABEL[part]}`);
          continue;
        }
        if (round4(n) !== now.value) out.push({ model: row.model_code, part, to: round4(n), from: now.value, fromHub: now.fromHub, sheet: now.sheet });
      }
    }
    return { changes: out, invalid: bad };
  }, [draft, rows]);

  if (error) {
    return (
      <div className="border border-dashed border-gray-200 rounded-xl p-12 text-center">
        <PackageOpen className="w-7 h-7 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-600 text-sm">{error}</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState icon={<PackageOpen className="w-7 h-7" />} title="No BOM rows" description="No BOM rows for the latest week." />;
  }

  const setPart = (model: string, part: Part, value: string | null) =>
    setDraft((d) => ({ ...d, [model]: { ...d[model], [part]: value } }));

  const undoPart = (model: string, part: Part) =>
    setDraft((d) => {
      const rest = { ...d[model] };
      delete rest[part];
      const next = { ...d };
      if (Object.keys(rest).length) next[model] = rest;
      else delete next[model];
      return next;
    });

  function save() {
    if (!changes.length || invalid.length) return;
    const summary = changes
      .map((c) => {
        const was = `${eur(c.from)}${c.fromHub ? "" : " (sheet)"}`;
        const to = c.to === null ? `the sheet's ${eur(c.sheet)}` : eur(c.to);
        return `• ${c.model} ${PART_LABEL[c.part]}: ${was} → ${to}`;
      })
      .join("\n");
    if (
      !window.confirm(
        `Save ${changes.length} Bamida price change${changes.length === 1 ? "" : "s"}?\n\n${summary}\n\n` +
          `Orders approved from now on are costed with these. Orders approved already keep the cost they froze.`,
      )
    )
      return;

    const byModel = new Map<string, SaveBamidaPricesInput["edits"][number]>();
    for (const c of changes) {
      const edit = byModel.get(c.model) ?? { model_code: c.model };
      if (c.part === "man") edit.manufacturing_eur = c.to;
      else edit.printing_eur = c.to;
      byModel.set(c.model, edit);
    }

    startTransition(async () => {
      const res = await saveBamidaPrices({ edits: [...byModel.values()] });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Saved ${res.updated} Bamida price${res.updated === 1 ? "" : "s"}` + (res.failed ? `; ${res.failed} did not save, try again` : ""),
      );
      setDraft({});
      void clearDraft();
      router.refresh();
    });
  }

  function priceCell(row: BomMasterRow, part: Part) {
    const now = current(row, part);
    if (!canEdit) {
      return (
        <>
          <span className="tabular-nums text-gray-900">{eur(now.value)}</span>
          {now.fromHub && <span className="block text-[10px] text-gray-400">sheet {eur(now.sheet)}</span>}
        </>
      );
    }
    const typed = draft[row.model_code]?.[part];
    if (typed === null) {
      return (
        <>
          <span className="tabular-nums text-gray-900">{eur(now.sheet)}</span>
          <span className="block text-[10px] text-echo-orange">
            the sheet&apos;s ·{" "}
            <button type="button" onClick={() => undoPart(row.model_code, part)} className="underline">
              undo
            </button>
          </span>
        </>
      );
    }
    const shown = typed ?? priceText(now.value);
    const changed = changes.some((c) => c.model === row.model_code && c.part === part);
    const wrong = invalid.includes(`${row.model_code} ${PART_LABEL[part]}`);
    return (
      <>
        <input
          value={shown}
          onChange={(e) => setPart(row.model_code, part, e.target.value)}
          inputMode="decimal"
          aria-label={`${row.model_code} ${PART_LABEL[part]} price`}
          className={inputCls + (wrong ? " border-red-500" : changed ? " border-echo-orange" : "")}
        />
        {changed && <span className="block text-[10px] text-gray-500 mt-0.5">was {eur(now.value)}</span>}
        {!changed && now.fromHub && (
          <span className="block text-[10px] text-gray-400 mt-0.5">
            sheet {eur(now.sheet)} ·{" "}
            <button
              type="button"
              onClick={() => setPart(row.model_code, part, null)}
              className="underline hover:text-gray-600"
              aria-label={`Use the sheet's ${PART_LABEL[part]} price for ${row.model_code}`}
            >
              use it
            </button>
          </span>
        )}
      </>
    );
  }

  return (
    <>
      {restored && (
        <div className="mb-3">
          <DraftStrip
            what="the Bamida prices you had typed"
            savedAt={savedAt}
            onStartAgain={async () => {
              await clearDraft();
              setDraft({});
            }}
            startAgainLabel="Discard them"
            saveStatus={saveStatus}
          />
        </div>
      )}

      <p className="text-xs text-gray-500 mb-3 max-w-3xl">
        Each product&apos;s bill of materials, priced from the material master. The manufacturing and printing prices are
        Bamida&apos;s per barrier: they come from Dave&apos;s sheet unless one has been set here, and one set here stays
        until it is handed back to the sheet. <span className="text-gray-600">Δ vs sheet</span> is what the edits made
        here change against the last synced week.
      </p>
      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <th className="text-left font-medium px-4 py-2">Model</th>
              <th className="text-left font-medium px-4 py-2">Line</th>
              <th className="text-right font-medium px-4 py-2">Components</th>
              <th className="text-right font-medium px-4 py-2">Manufacturing €</th>
              <th className="text-right font-medium px-4 py-2">Printing €</th>
              <th className="text-right font-medium px-4 py-2">SRO €</th>
              <th className="text-right font-medium px-4 py-2">BOM Total €</th>
              <th className="text-right font-medium px-4 py-2">Δ vs sheet</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = r.original_bom_total_eur != null && r.bom_total_eur != null ? r.bom_total_eur - r.original_bom_total_eur : null;
              return (
                <tr key={r.model_code} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2 font-mono text-xs text-echo-orange font-medium">
                    {r.model_code}
                    {r.hub_price && (
                      <span className="block font-sans text-[10px] text-gray-400 font-normal mt-0.5">
                        set by {r.hub_price.by ?? "the Hub"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{r.product_line ?? ""}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.component_detail.length}</td>
                  <td className="px-4 py-2 text-right">{priceCell(r, "man")}</td>
                  <td className="px-4 py-2 text-right">{priceCell(r, "print")}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-900">{eur(r.sro_total_eur)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-bold text-echo-orange">{eur(r.bom_total_eur)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {delta == null || Math.abs(delta) < 0.005 ? (
                      <span className="text-gray-400">0.00</span>
                    ) : (
                      <span className={delta > 0 ? "text-red-700" : "text-green-700"}>
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

      {invalid.length > 0 && (
        <p className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">
          Not a price: {invalid.join(", ")}. Type a number of euros, or leave the box as it was.
        </p>
      )}

      {canEdit ? (
        <div className="flex items-center justify-between mt-4">
          <span className="text-[10px] text-gray-400">
            {changes.length
              ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}`
              : `Sheet prices from the week of ${week ?? "unknown"}`}
          </span>
          <button
            onClick={save}
            disabled={pending || !changes.length || invalid.length > 0}
            className="inline-flex items-center gap-2 px-5 py-3 sm:py-2 bg-echo-orange hover:bg-echo-orange-hover disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Bamida prices
          </button>
        </div>
      ) : (
        <p className="text-[10px] text-gray-400 mt-2">Sheet prices from the week of {week ?? "unknown"}; the SRO order explosions read these live.</p>
      )}
    </>
  );
}
