import { requireCapability } from "@/lib/authz";
import { loadSroPoBoms, loadBomMaster, loadMaterials } from "@/lib/bom";
import { getSupplierByCode } from "@/lib/suppliers";
import { buildBamidaPo, type BamidaPo, type BamidaSupplier } from "@/lib/bamida-po";
import { stripBamidaPo, stripSroPoBomCosts, stripBomMasterCosts } from "@/lib/price-visibility";
import BomSection from "./bom-section";

export const dynamic = "force-dynamic";

export default async function BomPage() {
  const auth = await requireCapability(["bom.view", "bom.edit"]);
  const canEdit = auth.capabilities.has("bom.edit");
  const canViewCost = auth.capabilities.has("cost.view");

  const [orders, master, materials, supplierRow] = await Promise.all([
    loadSroPoBoms(),
    loadBomMaster(),
    // Materials master = a pricing view; only load it for cost.view holders.
    canViewCost ? loadMaterials() : Promise.resolve({ materials: [], week: null, error: undefined }),
    // Secondary, with a built-in default — never let it crash the BOM page.
    getSupplierByCode("BAMIDA, s.r.o.").catch(() => null),
  ]);

  // Only override the hardcoded default when we have a real address; an
  // existing-but-blank-address row would otherwise yield an addressless PO.
  const addressLines = (supplierRow?.address ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const bamidaSupplier: BamidaSupplier | undefined =
    supplierRow && addressLines.length
      ? { name: supplierRow.name, address: addressLines, taxNumber: supplierRow.tax_number ?? undefined }
      : undefined;

  // Build each Bamida supplier PO server-side from UNSTRIPPED data (so the line
  // set is right), then cost-strip for viewers without cost.view → the price-less
  // "BOM PO". The money never reaches a non-cost client (server-side enforced).
  const today = new Date().toISOString().slice(0, 10);
  const bamidaByPo: Record<string, BamidaPo> = {};
  for (const po of orders.pos) {
    const bp = buildBamidaPo(po, today, bamidaSupplier);
    bamidaByPo[po.id] = canViewCost ? bp : stripBamidaPo(bp);
  }

  // Strip the explosion + master costs for the same viewers.
  const pos = canViewCost ? orders.pos : orders.pos.map((p) => stripSroPoBomCosts(p, false));
  const masterRows = canViewCost ? master.rows : stripBomMasterCosts(master.rows, false);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Bill of Materials{canViewCost ? " & Pricing" : ""}
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Approved EB&nbsp;SRO orders exploded into their BOM
          {canViewCost && master.week ? ` — master prices week of ${master.week}` : ""}.
        </p>
      </div>

      <BomSection
        orders={pos}
        ordersError={orders.error}
        master={masterRows}
        masterWeek={master.week}
        masterError={master.error}
        materials={materials.materials}
        materialsError={materials.error}
        canEdit={canEdit}
        canViewCost={canViewCost}
        bamidaByPo={bamidaByPo}
      />
    </div>
  );
}
