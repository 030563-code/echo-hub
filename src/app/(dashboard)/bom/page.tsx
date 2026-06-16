import { requireCapability } from "@/lib/authz";
import { loadSroPoBoms, loadBomMaster } from "@/lib/bom";
import BomSection from "./bom-section";

export const dynamic = "force-dynamic";

export default async function BomPage() {
  const auth = await requireCapability(["bom.view", "bom.edit"]);
  const canEdit = auth.capabilities.has("bom.edit");

  const [orders, master] = await Promise.all([loadSroPoBoms(), loadBomMaster()]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Bill of Materials &amp; Pricing
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Approved EB&nbsp;SRO orders exploded into their BOM
          {master.week ? ` — master prices week of ${master.week}` : ""}.
        </p>
      </div>

      <BomSection
        orders={orders.pos}
        ordersError={orders.error}
        master={master.rows}
        masterWeek={master.week}
        masterError={master.error}
        canEdit={canEdit}
      />
    </div>
  );
}
