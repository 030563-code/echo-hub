import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { hasCapability } from "@/lib/authz";
import { commonDltDays, normalizeFlags } from "@/lib/mrp/board-format";

/**
 * Data module for the /mrp v2 SHADOW board (Task 12).
 *
 * SHADOW MODE: this feeds an observation-only section — operational decisions
 * still run on the LEGACY board (calculateMRP in actions.ts) until the Phase-2
 * cutover. Nothing read here drives actions, Slack, or POs.
 *
 * Reads the LATEST persisted run_date of mrp_buffer_status_daily joined to
 * mrp_buffer_profile. Alias profile rows (alias_of ≠ null) are excluded: the
 * engine rolls their demand into the target SKU and never persists status rows
 * for them, so the status-side filter below is belt-and-braces only.
 *
 * "No run persisted yet" is a LEGITIMATE state (the nightly job hasn't fired),
 * returned as lastRun: null with zero rows — never thrown.
 */

export interface V2BoardRow {
  sku: string;
  /** Nullable in the schema; the chip layer degrades unknown zones to neutral. */
  zone: string | null;
  nfp: number | null;
  projected_nfp: number | null;
  yellow_top: number | null;
  green_top: number | null;
  action_qty: number | null;
  /** Null = capacity unknown (no BOM mapped) — rendered as "—" + badge. */
  max_buildable: number | null;
  /** ns_number + snapshotted name of the component capping max_buildable. */
  materials_binding_code: string | null;
  materials_binding_desc: string | null;
  blocked_by_materials: boolean;
  /** Null when the SKU has no local demand history (Monte Carlo — Task 17) — rendered as "—". */
  p_stockout: number | null;
  /** 95% CI half-width on p_stockout; null alongside p_stockout. */
  p_stockout_ci: number | null;
  /** 'A' / 'B' / 'C' by local event count; null alongside p_stockout. */
  data_grade: string | null;
  flags: string[];
  /** Joined from mrp_buffer_profile (null if the profile row vanished). */
  dlt_days: number | null;
  sku_class: string | null;
}

export interface V2BoardData {
  /** Sorted red → yellow → green, then SKU. Empty = no engine run yet. */
  rows: V2BoardRow[];
  /** Null when mrp_buffer_status_daily has no rows (empty state). */
  lastRun: { runDate: string; createdAt: string | null } | null;
  /**
   * Most common dlt_days across non-alias profiles — sources the legacy
   * formula-reference line (replacing the hardcoded 90). Null = no profiles.
   */
  dltSeedDays: number | null;
}

const ZONE_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2 };

export async function getV2Board(): Promise<V2BoardData> {
  // Capability gate (defense in depth — the /mrp layout also gates the route).
  if (!(await hasCapability("mrp.view"))) {
    throw new Error("Forbidden: missing mrp.view capability");
  }

  // Service-role client: the board reads engine output across ALL SKUs, not
  // the caller's region-scoped slice. Authorized by the mrp.view gate above.
  const supabase = createAdminClient();

  // All profiles (including alias rows, so alias SKUs can be excluded by name).
  const { data: profileData, error: profileErr } = await supabase
    .from("mrp_buffer_profile")
    .select("sku, sku_class, dlt_days, alias_of");
  if (profileErr) throw new Error(`Failed to load buffer profiles: ${profileErr.message}`);
  const profiles = (profileData ?? []) as {
    sku: string;
    sku_class: string | null;
    dlt_days: number | null;
    alias_of: string | null;
  }[];

  const aliasSkus = new Set(profiles.filter((p) => p.alias_of !== null).map((p) => p.sku));
  const nonAlias = profiles.filter((p) => p.alias_of === null);
  const profileBySku = new Map(nonAlias.map((p) => [p.sku, p]));
  const dltSeedDays = commonDltDays(
    nonAlias.map((p) => p.dlt_days).filter((d): d is number => typeof d === "number")
  );

  // Latest persisted run — none yet is the documented empty state, not an error.
  const { data: latest, error: latestErr } = await supabase
    .from("mrp_buffer_status_daily")
    .select("run_date")
    .order("run_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw new Error(`Failed to load buffer status: ${latestErr.message}`);
  if (!latest) return { rows: [], lastRun: null, dltSeedDays };

  const { data: statusData, error: statusErr } = await supabase
    .from("mrp_buffer_status_daily")
    .select(
      "sku, nfp, projected_nfp, yellow_top, green_top, zone, action_qty, max_buildable, materials_binding_code, materials_binding_desc, blocked_by_materials, p_stockout, p_stockout_ci, data_grade, flags, created_at"
    )
    .eq("run_date", latest.run_date)
    .order("sku", { ascending: true });
  if (statusErr) throw new Error(`Failed to load buffer status rows: ${statusErr.message}`);

  let maxCreatedAt: string | null = null;
  const rows: V2BoardRow[] = [];
  for (const r of statusData ?? []) {
    // Belt-and-braces: alias spellings never make the board (the engine already
    // excludes them from persistence).
    if (aliasSkus.has(r.sku)) continue;
    // PostgREST timestamps share one ISO format, so lexical max is correct.
    if (typeof r.created_at === "string" && (maxCreatedAt === null || r.created_at > maxCreatedAt)) {
      maxCreatedAt = r.created_at;
    }
    const profile = profileBySku.get(r.sku);
    rows.push({
      sku: r.sku,
      zone: r.zone ?? null,
      nfp: r.nfp ?? null,
      projected_nfp: r.projected_nfp ?? null,
      yellow_top: r.yellow_top ?? null,
      green_top: r.green_top ?? null,
      action_qty: r.action_qty ?? null,
      max_buildable: r.max_buildable ?? null,
      materials_binding_code: r.materials_binding_code ?? null,
      materials_binding_desc: r.materials_binding_desc ?? null,
      blocked_by_materials: r.blocked_by_materials === true,
      p_stockout: r.p_stockout ?? null,
      p_stockout_ci: r.p_stockout_ci ?? null,
      data_grade: r.data_grade ?? null,
      flags: normalizeFlags(r.flags),
      dlt_days: profile?.dlt_days ?? null,
      sku_class: profile?.sku_class ?? null,
    });
  }

  rows.sort(
    (a, b) =>
      (ZONE_ORDER[a.zone ?? ""] ?? 3) - (ZONE_ORDER[b.zone ?? ""] ?? 3) ||
      a.sku.localeCompare(b.sku)
  );

  return {
    rows,
    lastRun: { runDate: latest.run_date as string, createdAt: maxCreatedAt },
    dltSeedDays,
  };
}
