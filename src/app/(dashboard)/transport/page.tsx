import { createServerClient } from "@/lib/supabase/server";
import ShippingClient from "./transport-client";
import type { ShipmentContent } from "@/lib/erp-types";
import { groupBySpotId } from "@/lib/shipment-grouping";

export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const supabase = await createServerClient();

  const { data: shipments } = await supabase
    .from("shipment_contents")
    .select("*")
    .order("eta", { ascending: true });

  const items = (shipments ?? []) as ShipmentContent[];

  // Counted over SHIPMENTS, not SKU lines, so the strip agrees with the board
  // underneath it. A container of four models is one thing on water, not four.
  const grouped = groupBySpotId(items);
  const onWater = grouped.filter((g) => g.status === "on_water").length;
  const atPort = grouped.filter((g) => g.status === "at_port").length;
  const customs = grouped.filter((g) => g.status === "customs").length;
  const totalUnits = items.reduce((sum, i) => sum + i.qty, 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Logistics & Shipping
        </h1>
        <p className="text-gray-500 text-sm mt-1">Active containers and shipments in transit</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Shipments", value: grouped.length, color: "text-gray-900" },
          { label: "On Water", value: onWater, color: "text-blue-700" },
          { label: "At Port / Customs", value: atPort + customs, color: "text-amber-700" },
          { label: "Units in Transit", value: totalUnits, color: "text-echo-orange" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
            <p className="text-gray-500 text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <ShippingClient items={items} />
    </div>
  );
}
