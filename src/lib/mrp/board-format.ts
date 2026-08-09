/**
 * Pure display helpers for the /mrp v2 SHADOW board (Task 12).
 *
 * SHADOW MODE: the v2 section renders the nightly DDMRP engine's persisted
 * output for observation only — operational decisions still run on the LEGACY
 * board until the Phase-2 cutover. Nothing here computes buffer math; these
 * are presentation-only mappings over mrp_buffer_status_daily /
 * mrp_buffer_profile values, extracted so vitest can pin them without
 * rendering the page.
 */

export type BufferZone = "red" | "yellow" | "green";

// Zone chip palette — mirrors the legacy traffic-light summary cards so red on
// the v2 board reads as the same red operators already know.
const ZONE_CHIP: Record<BufferZone, string> = {
  red: "bg-red-950/40 text-red-300 border-red-900/50",
  yellow: "bg-yellow-950/30 text-yellow-300 border-yellow-900/50",
  green: "bg-emerald-950/30 text-emerald-300 border-emerald-900/50",
};

// The zone column is nullable in mrp_buffer_status_daily; anything that isn't
// one of the three zones gets the neutral chip rather than crashing the row.
const ZONE_CHIP_FALLBACK = "bg-[#1e1e1e] text-[#9ca3af] border-[#2a2a2a]";

/** Tailwind classes for a zone chip; unknown/null zones degrade to neutral. */
export function zoneChipClasses(zone: string): string {
  return ZONE_CHIP[zone as BufferZone] ?? ZONE_CHIP_FALLBACK;
}

// Engine flag vocabulary (see engine.ts) — humanized for badge display.
const FLAG_LABELS: Record<string, string> = {
  stock_unverified: "Stock unverified",
  buffers_unseeded: "Buffers unseeded",
  spikes_skipped_no_buffer: "Spikes skipped (no buffer)",
  thin_history: "Thin history",
  demand_capture_gap: "Demand capture gap",
  stock_drift: "Stock drift",
  // Materials-gate vocabulary. "Provisional" is the one that matters
  // operationally: the ceiling beside it is real, but the SKU→finished-good
  // mapping behind it is inference, so the engine deliberately refuses to let
  // it block. Reading it as a hard constraint would be the wrong conclusion.
  materials_unmapped: "No BOM mapped",
  materials_map_provisional: "BOM mapping provisional",
  pallet_size_unknown: "Pallet size unknown",
  bom_estimated: "BOM estimated",
};

/**
 * Humanized badge label for an engine flag. Unknown flags (future engine
 * vocabulary) degrade to sentence case instead of raw snake_case.
 */
export function humanizeFlag(flag: string): string {
  const known = FLAG_LABELS[flag];
  if (known !== undefined) return known;
  const words = flag.replace(/_/g, " ").trim();
  return words === "" ? flag : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Defensive read of the jsonb `flags` column: the engine contract is an array
 * of strings, but a hand-edited row must degrade to no badges, not a crash.
 */
export function normalizeFlags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === "string");
}

/**
 * Display form of a buffer quantity. NFP columns are numeric (firm demand can
 * be fractional), so fractional values render with one decimal; integers stay
 * bare. Null/undefined/non-finite → em dash.
 */
export function formatQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Whether projected NFP earns its second (muted) value: only when it differs
 * from NFP at display precision — float noise must never render a phantom
 * delta. Null projected never shows.
 */
export function projectedDiffers(
  nfp: number | null | undefined,
  projected: number | null | undefined
): boolean {
  if (projected === null || projected === undefined) return false;
  return formatQty(projected) !== formatQty(nfp);
}

/**
 * The materials line: how many units the factory could build, and — the part
 * that is actually actionable — which component caps it.
 *
 * A bare ceiling tells nobody what to do about it. The binding component is
 * often the surprise: H9 reads 280 because of four pieces of a metal securing
 * clip, while everyone assumes fabric is the constraint. Falls back to the raw
 * ns_number when no description was snapshotted, and to the bare number when
 * nothing bound (an unconstrained BOM). Null ceiling → em dash.
 */
export function formatMaxBuildable(
  maxBuildable: number | null | undefined,
  bindingCode: string | null | undefined,
  bindingDesc: string | null | undefined
): string {
  if (maxBuildable === null || maxBuildable === undefined || !Number.isFinite(maxBuildable)) {
    return "—";
  }
  const label = bindingDesc?.trim() || bindingCode?.trim();
  return label ? `${maxBuildable} · capped by ${label}` : String(maxBuildable);
}

/**
 * p_stockout chip text. The engine does not write this column yet (a later
 * task owns the stockout model), so every live row is null → em dash. When it
 * lands it is a probability in [0, 1]; rendered as a whole percent.
 */
export function formatPStockout(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${Math.round(p * 100)}%`;
}

/**
 * Representative dlt_days across buffer profiles for the legacy formula line:
 * the most common value (every profile carries the 75d seed today), ties
 * broken by the smaller value so the result is deterministic. Null when no
 * finite values exist.
 */
export function commonDltDays(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * The "last run" line under the v2 table. run_date is the engine's run day;
 * created_at (max across the run's rows) is when persistence happened.
 * Rendered in UTC so the server-rendered string is deterministic regardless of
 * server locale/timezone. Invalid/missing created_at degrades to the run date.
 */
export function formatLastRun(runDate: string, createdAtIso: string | null): string {
  if (createdAtIso !== null) {
    const t = new Date(createdAtIso);
    if (!Number.isNaN(t.getTime())) {
      const hh = String(t.getUTCHours()).padStart(2, "0");
      const mm = String(t.getUTCMinutes()).padStart(2, "0");
      return `Last run ${runDate} · persisted ${hh}:${mm} UTC`;
    }
  }
  return `Last run ${runDate}`;
}
