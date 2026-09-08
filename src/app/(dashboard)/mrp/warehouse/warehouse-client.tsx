"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Pencil, X, Warehouse } from "lucide-react";
import { updateWarehouseStock } from "./actions";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchBox } from "@/components/ui/search-box";
import type { WarehouseStock } from "@/lib/erp-types";
import { cn } from "@/lib/utils";
import { usePersistedView } from "@/hooks/use-page-state";
import { parseSearchView, type SearchView } from "@/lib/page-drafts";

export default function WarehouseClient({ initialStock }: { initialStock: WarehouseStock[] }) {
  const [stock, setStock] = useState(initialStock);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // Counting stock means looking one SKU up, leaving, and coming back to it.
  const [qView, setQView] = usePersistedView<SearchView>(
    "warehouse-stock",
    { v: 1, q: "" },
    parseSearchView,
  );
  const q = qView.q;
  const setQ = (next: string) => setQView({ v: 1, q: next });
  const [, startTransition] = useTransition();

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? stock.filter((s) => (s.sku + " " + (s.product_name ?? "")).toLowerCase().includes(needle))
    : stock;

  const grouped = filtered.reduce<Record<string, WarehouseStock[]>>((acc, item) => {
    if (!acc[item.warehouse_code]) acc[item.warehouse_code] = [];
    acc[item.warehouse_code].push(item);
    return acc;
  }, {});

  async function saveEdit(item: WarehouseStock) {
    const qty = parseInt(editValue, 10);
    if (isNaN(qty) || qty < 0) { setEditingId(null); return; }

    const result = await updateWarehouseStock(item.id, qty);

    if ("success" in result) {
      startTransition(() => {
        setStock((prev) =>
          prev.map((s) => s.id === item.id ? { ...s, quantity_on_hand: qty } : s)
        );
      });
      toast.success(`${item.sku} stock updated to ${qty}`);
    } else {
      toast.error(result.error);
    }
    setEditingId(null);
  }

  function stockColor(qty: number) {
    if (qty === 0) return "text-red-700";
    if (qty < 10) return "text-amber-700";
    return "text-emerald-700";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400">{stock.length} SKU{stock.length !== 1 ? "s" : ""} on hand</span>
        <SearchBox value={q} onChange={setQ} placeholder="Search SKU or product…" />
      </div>

      {Object.keys(grouped).length === 0 ? (
        <EmptyState
          icon={<Warehouse className="w-7 h-7" />}
          title={needle ? "No matching stock" : "No stock records"}
          description={needle ? `Nothing matches “${q}”.` : "No warehouse stock levels to show yet."}
        />
      ) : (
        Object.entries(grouped).map(([warehouse, items]) => (
        <div key={warehouse}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-gray-900 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg font-mono">
              {warehouse}
            </span>
            <span className="text-xs text-gray-400">{items.length} SKUs</span>
          </div>

          <div className="overflow-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  {["SKU", "Product Name", "In Stock", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-echo-orange">{item.sku}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-600">{item.product_name ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      {editingId === item.id ? (
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(item);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="w-20 px-2 py-1 bg-white border border-echo-orange/50 rounded text-base sm:text-sm text-gray-900 focus:outline-none"
                        />
                      ) : (
                        <span className={cn("text-sm font-bold tabular-nums", stockColor(item.quantity_on_hand))}>
                          {item.quantity_on_hand}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingId === item.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => saveEdit(item)} className="p-3 sm:p-1 text-emerald-600 hover:text-emerald-700 transition-colors">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="p-3 sm:p-1 text-gray-500 hover:text-gray-900 transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingId(item.id); setEditValue(String(item.quantity_on_hand)); }}
                          className="p-3 sm:p-1 text-gray-400 hover:text-echo-orange transition-colors opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        ))
      )}
    </div>
  );
}
