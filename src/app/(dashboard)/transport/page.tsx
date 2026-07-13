import { createServerClient } from "@/lib/supabase/server";
import ShippingClient from "./transport-client";
import type { ShipmentContent } from "@/lib/erp-types";

export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const supabase = await createServerClient();

  const { data: shipments } = await supabase
    .from("shipment_contents")
    .select("*")
    .order("eta", { ascending: true });

  const items = (shipments ?? []) as ShipmentContent[];
  const onWater = items.filter((i) => i.status === "on_water").length;
  const atPort = items.filter((i) => i.status === "at_port").length;
  const customs = items.filter((i) => i.status === "customs").length;
  const totalUnits = items.reduce((sum, i) => sum + i.qty, 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Logistics & Shipping
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">Active containers and shipments in transit</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total Lines", value: items.length, color: "text-white" },
          { label: "On Water", value: onWater, color: "text-blue-300" },
          { label: "At Port / Customs", value: atPort + customs, color: "text-yellow-300" },
          { label: "Units in Transit", value: totalUnits, color: "text-[#FF7026]" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
            <p className="text-[#6b7280] text-xs mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <ShippingClient items={items} />
    </div>
  );
}
