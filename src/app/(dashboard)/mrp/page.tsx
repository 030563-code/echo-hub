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
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-red-700 text-sm">
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
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
          MRP Prediction Dashboard
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Reorder point engine — CIP vs Lead Time Demand + Safety Stock per SKU
        </p>
      </div>

      {/* v2 SHADOW board — observation only until the Phase-2 cutover */}
      <V2ShadowBoard data={v2} />

      {/* ===== LEGACY BOARD (decisions run HERE until Phase-2 cutover) ===== */}

      {/* Traffic light summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-xs text-red-700 font-medium uppercase tracking-wider">Manufacture Now</span>
          </div>
          <p className="text-4xl font-bold text-red-700">{red}</p>
          <p className="text-xs text-red-600 mt-0.5">SKUs critically low</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span className="text-xs text-amber-700 font-medium uppercase tracking-wider">Watch</span>
          </div>
          <p className="text-4xl font-bold text-amber-700">{yellow}</p>
          <p className="text-xs text-amber-600 mt-0.5">SKUs below threshold</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-emerald-500" />
            <span className="text-xs text-emerald-700 font-medium uppercase tracking-wider">OK</span>
          </div>
          <p className="text-4xl font-bold text-emerald-700">{green}</p>
          <p className="text-xs text-emerald-600 mt-0.5">SKUs healthy</p>
        </div>
      </div>

      {/* Formula reference */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 mb-6 text-xs text-gray-600 space-y-1">
        <p className="text-blue-800 font-medium mb-2">Formula Reference</p>
        <p><span className="text-gray-600">CIP</span> = In Stock + In Transit + On Order</p>
        <p><span className="text-gray-600">Pipeline Demand</span> = Σ(Quote Qty × Deal Probability)</p>
        <p>
          <span className="text-gray-600">Lead Time Demand</span> = (Daily Run Rate × {dltSeedDays} days) + Pipeline Demand{" "}
          {/* 90d = DEFAULT_LEAD_TIME_DAYS in actions.ts — the legacy engine's
              computation input, disclosed here so operators can reproduce the
              board's numbers while the display shows the profile-sourced DLT. */}
          <span className="text-gray-400">(target lead time from mrp_buffer_profile; seed — recalibrating from live shipments; the legacy trigger above still computes with 90d until cutover)</span>
        </p>
        <p><span className="text-red-700">Trigger</span> = CIP ≤ Lead Time Demand + Safety Stock</p>
        <p className="text-gray-400 pt-1">⚠ All stock currently at 0 — red status expected until Dave provides real quantities</p>
      </div>

      <MRPClient rows={rows} />
    </div>
  );
}
