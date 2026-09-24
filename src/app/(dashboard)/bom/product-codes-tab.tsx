"use client";

// page-state: none (each choice saves the moment it is confirmed)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, PackageOpen } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { saveProductModel } from "@/app/actions/bom/product-model";
import type { ProductModelRow } from "@/lib/sku-model";

const selectCls =
  "w-full max-w-[15rem] px-2 py-1.5 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 focus:outline-none focus:border-echo-orange transition-colors disabled:opacity-50";

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";

/**
 * Which bill of materials each product code is costed with. The product list
 * spells some products the way the demand history does (H9X, dB-RT) where the
 * manufacturing sheet says H9X 2.1W and NDT, and a code the bill of materials
 * cannot find reaches the -1 and the -3 with no materials and no Bamida prices.
 */
export default function ProductCodesTab({
  rows,
  bomModels,
  error,
  canEdit,
}: {
  rows: ProductModelRow[];
  bomModels: string[];
  error?: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (error) {
    return (
      <div className="border border-dashed border-gray-200 rounded-xl p-12 text-center">
        <PackageOpen className="w-7 h-7 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-600 text-sm">{error}</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState icon={<PackageOpen className="w-7 h-7" />} title="No product codes" description="Neither product list has a code to show." />;
  }

  const missing = rows.filter((r) => !r.hasBom).length;
  // Nothing to choose from while the bill of materials cannot be read.
  const editable = canEdit && bomModels.length > 0;

  function choose(row: ProductModelRow, next: string | null) {
    const target = next ?? row.listModel;
    const what = next ? next : `what the product list says${row.listModel ? ` (${row.listModel})` : ""}`;
    if (
      !window.confirm(
        `Cost ${row.sku} as ${what}?\n\n` +
          `Orders approved from now on take the materials and Bamida prices of ${target ?? "no model at all"}. ` +
          `An order approved already keeps the cost it froze until it is re-costed.`,
      )
    )
      return;
    setSaving(row.sku);
    startTransition(async () => {
      const res = await saveProductModel({ sku: row.sku, model_code: next });
      setSaving(null);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.sku} is costed as ${target ?? "nothing"}`);
      router.refresh();
    });
  }

  return (
    <>
      <p className="text-xs text-gray-500 mb-1 max-w-3xl">
        The model each product code is costed as. It decides the materials on the specification and the Bamida
        manufacturing and printing prices on the priced order.
      </p>
      <p className={"text-xs mb-3 " + (missing ? "text-amber-700" : "text-gray-500")}>
        {missing
          ? `${missing} product code${missing === 1 ? " has" : "s have"} no bill of materials, so their orders carry no materials and no Bamida prices.`
          : "Every product code here finds a bill of materials."}
      </p>
      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <th className="text-left font-medium px-4 py-2">Product code</th>
              <th className="text-left font-medium px-4 py-2">Product</th>
              <th className="text-left font-medium px-4 py-2">Ordered by</th>
              <th className="text-left font-medium px-4 py-2">Product list says</th>
              <th className="text-left font-medium px-4 py-2">Costed as</th>
              <th className="text-left font-medium px-4 py-2">Bill of materials</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku} className="border-t border-gray-100 align-top">
                <td className="px-4 py-2 font-mono text-xs text-echo-orange font-medium">{r.sku}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{r.name ?? ""}</td>
                <td className="px-4 py-2 text-xs text-gray-500">{r.orderedBy}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-600">{r.listModel ?? <span className="font-sans text-gray-400">none</span>}</td>
                <td className="px-4 py-2">
                  {editable ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Model ${r.sku} is costed as`}
                        value={r.chosenModel ?? ""}
                        disabled={pending}
                        onChange={(e) => choose(r, e.target.value || null)}
                        className={selectCls}
                      >
                        <option value="">{r.listModel ? `${r.listModel} (as listed)` : "No model (as listed)"}</option>
                        {bomModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      {saving === r.sku && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                    </div>
                  ) : (
                    <span className="font-mono text-xs text-gray-900">{r.model ?? ""}</span>
                  )}
                  {r.chosenModel && (
                    <span className="block text-[10px] text-gray-400 mt-0.5">
                      Chosen by {r.chosenBy ?? "the Hub"}
                      {r.chosenAt ? ` · ${shortDate(r.chosenAt)}` : ""}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.hasBom ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 border border-green-200 text-green-800">Found</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800">
                      {r.model ? `None for ${r.model}` : "No model"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && bomModels.length === 0 && (
        <p className="text-xs text-amber-700 mt-3">The bill of materials could not be read, so there are no models to choose from right now.</p>
      )}
    </>
  );
}
