"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";
import { updateWarehouseStock } from "./actions";
import type { WarehouseStock } from "@/lib/erp-types";
import { cn } from "@/lib/utils";

export default function WarehouseClient({ initialStock }: { initialStock: WarehouseStock[] }) {
  const [stock, setStock] = useState(initialStock);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [, startTransition] = useTransition();

  const grouped = stock.reduce<Record<string, WarehouseStock[]>>((acc, item) => {
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
    }
    setEditingId(null);
  }

  function stockColor(qty: number) {
    if (qty === 0) return "text-red-300";
    if (qty < 10) return "text-yellow-300";
    return "text-emerald-300";
  }

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([warehouse, items]) => (
        <div key={warehouse}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-white px-2 py-1 bg-[#1e2a3a] border border-blue-900/40 rounded-lg font-mono">
              {warehouse}
            </span>
            <span className="text-xs text-[#4b5563]">{items.length} SKUs</span>
          </div>

          <div className="overflow-auto rounded-lg border border-[#2a2a2a]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#2a2a2a] bg-[#161616]">
                  {["SKU", "Product Name", "In Stock", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-[#6b7280] uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[#1e1e1e] last:border-0 hover:bg-[#1a1a1a] transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-[#FF7026]">{item.sku}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-[#9ca3af]">{item.product_name ?? "—"}</span>
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
                          className="w-20 px-2 py-1 bg-[#2a2a2a] border border-[#FF7026]/50 rounded text-sm text-white focus:outline-none"
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
                          <button onClick={() => saveEdit(item)} className="p-1 text-emerald-400 hover:text-emerald-300 transition-colors">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="p-1 text-[#6b7280] hover:text-white transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingId(item.id); setEditValue(String(item.quantity_on_hand)); }}
                          className="p-1 text-[#4b5563] hover:text-[#FF7026] transition-colors opacity-0 group-hover:opacity-100"
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
      ))}
    </div>
  );
}
