import { createServerClient } from "@/lib/supabase/server";
import { requireCapability } from "@/lib/authz";
import WarehouseClient from "./warehouse-client";
import type { WarehouseStock } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  // Within the mrp.view'd subtree, the stock-override page itself requires stock.edit.
  await requireCapability("stock.edit");
  const supabase = await createServerClient();

  const { data: stock } = await supabase
    .from("warehouse_stock_levels")
    .select("*")
    .order("warehouse_code")
    .order("sku");

  const items = (stock ?? []) as WarehouseStock[];
  const totalSkus = items.length;
  const zeroStock = items.filter((i) => i.quantity_on_hand === 0).length;
  const lowStock = items.filter((i) => i.quantity_on_hand > 0 && i.quantity_on_hand < 10).length;
  const totalUnits = items.reduce((sum, i) => sum + i.quantity_on_hand, 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          North American Warehousing
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">Live stock levels across EB-SRO and North American depots</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total SKUs", value: totalSkus, color: "text-white" },
          { label: "Total Units", value: totalUnits, color: "text-[#FF7026]" },
          { label: "Zero Stock", value: zeroStock, color: zeroStock > 0 ? "text-red-300" : "text-emerald-300" },
          { label: "Low Stock (<10)", value: lowStock, color: lowStock > 0 ? "text-yellow-300" : "text-emerald-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
            <p className="text-[#6b7280] text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <WarehouseClient initialStock={items} />
    </div>
  );
}
