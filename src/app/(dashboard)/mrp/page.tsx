import { calculateMRP } from "./actions";
import MRPClient from "./mrp-client";
import V2ShadowBoard from "./v2-board";
import { getV2Board, type V2BoardData } from "./v2-data";

export const dynamic = "force-dynamic";

export default async function MRPPage() {
  // v2 SHADOW board (Task 12): loaded independently so a v2 failure (or the
  // documented "no engine run yet" empty state) can never take down the legacy
  // board — decisions still run on the LEGACY board until the Phase-2 cutover.
  let v2: V2BoardData | null = null;
  try {
    v2 = await getV2Board();
  } catch {
    v2 = null;
  }

  let rows;
  try {
    rows = await calculateMRP();
  } catch {
    return (
      <div className="p-6">
        <div className="bg-red-950/30 border border-red-900/40 rounded-xl px-5 py-4 text-red-300 text-sm">
          Failed to load MRP data. Please refresh or contact your administrator.
        </div>
      </div>
    );
  }

  const red = rows.filter((r) => r.status === "red").length;
  const yellow = rows.filter((r) => r.status === "yellow").length;
  const green = rows.filter((r) => r.status === "green").length;

  // Legacy formula line: lead time now sourced from mrp_buffer_profile
  // dlt_days (most common value across profiles — the 75d seed today);
  // 90 remains only as the fallback when profiles are unavailable.
  const dltSeedDays = v2?.dltSeedDays ?? 90;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          MRP Prediction Dashboard
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Reorder point engine — CIP vs Lead Time Demand + Safety Stock per SKU
        </p>
      </div>

      {/* v2 SHADOW board — observation only until the Phase-2 cutover */}
      <V2ShadowBoard data={v2} />

      {/* ===== LEGACY BOARD (decisions run HERE until Phase-2 cutover) ===== */}

      {/* Traffic light summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-red-950/30 border border-red-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-red-400 shadow-lg shadow-red-400/50" />
            <span className="text-xs text-red-300 font-medium uppercase tracking-wider">Manufacture Now</span>
          </div>
          <p className="text-4xl font-bold text-red-300">{red}</p>
          <p className="text-xs text-red-400/70 mt-0.5">SKUs critically low</p>
        </div>
        <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-yellow-400 shadow-lg shadow-yellow-400/50" />
            <span className="text-xs text-yellow-300 font-medium uppercase tracking-wider">Watch</span>
          </div>
          <p className="text-4xl font-bold text-yellow-300">{yellow}</p>
          <p className="text-xs text-yellow-400/70 mt-0.5">SKUs below threshold</p>
        </div>
        <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
            <span className="text-xs text-emerald-300 font-medium uppercase tracking-wider">OK</span>
          </div>
          <p className="text-4xl font-bold text-emerald-300">{green}</p>
          <p className="text-xs text-emerald-400/70 mt-0.5">SKUs healthy</p>
        </div>
      </div>

      {/* Formula reference */}
      <div className="bg-[#1a1a2e] border border-blue-900/30 rounded-xl px-5 py-4 mb-6 text-xs text-[#6b7280] space-y-1">
        <p className="text-blue-300 font-medium mb-2">Formula Reference</p>
        <p><span className="text-[#9ca3af]">CIP</span> = In Stock + In Transit + On Order</p>
        <p><span className="text-[#9ca3af]">Pipeline Demand</span> = Σ(Quote Qty × Deal Probability)</p>
        <p>
          <span className="text-[#9ca3af]">Lead Time Demand</span> = (Daily Run Rate × {dltSeedDays} days) + Pipeline Demand{" "}
          <span className="text-[#4b5563]">(lead time = mrp_buffer_profile dlt_days; seed — recalibrating from live shipments)</span>
        </p>
        <p><span className="text-red-400">Trigger</span> = CIP ≤ Lead Time Demand + Safety Stock</p>
        <p className="text-[#4b5563] pt-1">⚠ All stock currently at 0 — red status expected until Dave provides real quantities</p>
      </div>

      <MRPClient rows={rows} />
    </div>
  );
}
