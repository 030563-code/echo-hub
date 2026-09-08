import {
  formatDataGrade,
  formatLastRun,
  formatPStockout,
  formatQty,
  humanizeFlag,
  pStockoutCiHint,
  projectedDiffers,
  zoneChipClasses,
} from "@/lib/mrp/board-format";
import type { V2BoardData } from "./v2-data";

// ============================================================================
// /mrp v2 SHADOW board (Task 12).
//
// SHADOW: this section observes the nightly DDMRP engine's persisted output
// (mrp_buffer_status_daily ⋈ mrp_buffer_profile). Operational decisions still
// run on the LEGACY board below until the Phase-2 cutover — nothing here feeds
// actions, Slack, or POs.
//
// Server component by design: data arrives from page.tsx (mirroring how the
// legacy board loads) and the table is static — no tanstack/client boundary.
// data === null means the v2 fetch failed; the section degrades to a notice so
// the legacy board is never taken down by the shadow.
// ============================================================================

function FlagBadge({ flag }: { flag: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600">
      {humanizeFlag(flag)}
    </span>
  );
}

const TH = "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-gray-500";

export default function V2ShadowBoard({ data }: { data: V2BoardData | null }) {
  let body: React.ReactNode;

  if (data === null) {
    body = (
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 text-sm text-gray-600">
        v2 board unavailable — buffer status could not be loaded. The legacy board below is
        unaffected.
      </div>
    );
  } else if (data.rows.length === 0) {
    // EMPTY STATE: no engine run has persisted yet — a legitimate state while
    // the nightly job hasn't fired, never an error.
    body = (
      <div className="rounded-xl border border-dashed border-gray-200 px-6 py-10 text-center">
        <p className="text-sm font-semibold text-gray-900">No engine run yet</p>
        <p className="mt-1.5 text-xs text-gray-500">
          The nightly job populates this board — no runs persisted in mrp_buffer_status_daily so
          far.
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className={TH}>Zone</th>
                <th className={TH}>SKU</th>
                <th className={TH}>NFP / buffer tops</th>
                <th className={TH}>Action qty</th>
                <th className={TH}>Max buildable</th>
                <th className={TH}>P(stockout)</th>
                <th className={TH}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.sku} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${zoneChipClasses(r.zone ?? "")}`}
                    >
                      {r.zone ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs font-medium text-echo-orange">{r.sku}</span>
                    {r.dlt_days !== null && (
                      <span className="block text-[10px] text-gray-400">DLT {r.dlt_days}d</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <span className="text-sm font-bold tabular-nums text-gray-900">
                      {formatQty(r.nfp)}
                    </span>
                    {/* Projected NFP: second, muted value ONLY when it differs. */}
                    {projectedDiffers(r.nfp, r.projected_nfp) && (
                      <span
                        className="ml-1.5 text-xs tabular-nums text-gray-500"
                        title="Projected NFP"
                      >
                        → {formatQty(r.projected_nfp)}
                      </span>
                    )}
                    <span className="block text-[10px] tabular-nums text-gray-400">
                      yellow ≤ {formatQty(r.yellow_top)} · green ≤ {formatQty(r.green_top)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-sm font-bold tabular-nums ${(r.action_qty ?? 0) > 0 ? "text-echo-orange" : "text-gray-400"}`}
                    >
                      {formatQty(r.action_qty)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.max_buildable === null ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-sm text-gray-400">—</span>
                        <FlagBadge flag="materials_unmapped" />
                      </span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <span
                          className={`text-sm tabular-nums ${r.blocked_by_materials ? "font-bold text-red-700" : "text-gray-900"}`}
                        >
                          {formatQty(r.max_buildable)}
                        </span>
                        {/* The ceiling alone is not actionable — name the
                            component to reorder. Often the surprise: H9 caps on
                            a metal clip, not on fabric. */}
                        {r.materials_binding_desc || r.materials_binding_code ? (
                          <span className="text-[10px] leading-tight text-gray-500">
                            capped by {r.materials_binding_desc || r.materials_binding_code}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] tabular-nums text-gray-600">
                        {formatPStockout(r.p_stockout)}
                      </span>
                      {r.data_grade !== null && (
                        <span
                          className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[9px] font-medium text-gray-500"
                          title="Data grade — local demand-event count behind this probability"
                        >
                          {formatDataGrade(r.data_grade)}
                        </span>
                      )}
                    </span>
                    {/* Wide CI (>0.30) means the SKU hasn't got enough local
                        history yet — the probability isn't worth acting on. */}
                    {pStockoutCiHint(r.p_stockout_ci) && (
                      <span className="block text-[10px] text-gray-500">
                        {pStockoutCiHint(r.p_stockout_ci)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {(() => {
                      // materials_unmapped already renders inline in the
                      // Max-buildable cell when the value is null — don't badge
                      // it twice on the same row.
                      const flags =
                        r.max_buildable === null
                          ? r.flags.filter((f) => f !== "materials_unmapped")
                          : r.flags;
                      return flags.length === 0 ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : (
                        <div className="flex max-w-[280px] flex-wrap gap-1">
                          {flags.map((f) => (
                            <FlagBadge key={f} flag={f} />
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.lastRun && (
          <p className="mt-2 text-[10px] text-gray-400">
            {formatLastRun(data.lastRun.runDate, data.lastRun.createdAt)}
          </p>
        )}
      </>
    );
  }

  return (
    <section className="mb-8">
      <div className="mb-1 flex items-center gap-2">
        <h2
          className="text-lg font-bold text-gray-900"
          style={{ fontFamily: "Varela Round, sans-serif" }}
        >
          DDMRP Buffer Board
        </h2>
        <span className="inline-flex items-center rounded-full border border-echo-orange/40 bg-echo-orange/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-echo-orange">
          v2 · shadow
        </span>
      </div>
      <p className="mb-4 text-xs text-gray-500">
        Nightly engine output — observation only. Decisions still run on the legacy board below
        until the Phase-2 cutover.
      </p>
      {body}
    </section>
  );
}
