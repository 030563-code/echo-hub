/**
 * Monte Carlo backtest against real UK demand history (plan Task 18).
 *   Q1 CALIBRATION — when simulateStockout says 30%, does it happen ~30% of
 *      the time?
 *   Q2 DECISION QUALITY — does triggering on probability (Task 19) beat
 *      triggering on buffer zones?
 * UK is the donor: real, deep (EBH9 = 774 events, 2011→2026) and independent
 * of the NA demo data.
 *
 * READ-ONLY: only queries mrp_demand_events and mrp_lead_time_actuals; writes
 * NOTHING to the database. Its only output is a local JSON file under
 * scripts/demo/out/ (gitignored).
 *
 * Usage: npx dotenv-cli -e .env.local -- npx tsx scripts/backtest-mc-uk.ts [FAMILY]
 *   FAMILY defaults to EBH9 (product_code_master.internal_sku vocabulary,
 *   the UK ledger's join key — see mrp_buffer_profile.family_sku).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { calibrate, brierScore, demandOver, type HistEvent, type Trial } from "../src/lib/mrp/backtest";
import { simulateZonePolicy, simulateMcPolicy, type SimConfig, type PolicyResult } from "../src/lib/mrp/policy-sim";
import { mulberry32, seedFrom, simulateStockout, type McLegSamples } from "../src/lib/mrp/montecarlo";
import { varFactorFromCov } from "../src/lib/mrp/buffers";

const MS_PER_DAY = 86_400_000;
/** The engine's current DLT (mrp_buffer_profile seed: mfg 45 + ocean 21 + customs 9 + door-actuals recalibration ≈ 79) — fixed so predicted and observed cover the same window. */
const LEAD_DAYS = 79;
const POSITION_FACTORS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const WINDOW_START = new Date("2025-01-06T00:00:00Z");
const WINDOW_END = new Date("2026-07-27T00:00:00Z");
const MC_THRESHOLDS = [0.03, 0.08, 0.12];
const PAGE = 1000;
/** Bucket must have this many trials before its calibration gap counts toward the verdict. */
const MIN_BUCKET_N = 30;
/** Not plan-specified — chosen here as a reportable bar; DDS&OP should confirm or replace it. */
const ACCEPTABLE_CALIBRATION_GAP = 0.1;

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}`);
    process.exit(1);
  }
  return v;
}

function assertProject(url: string, expected: string) {
  const host = new URL(url).host;
  if (host !== `${expected}.supabase.co` && process.env.ALLOW_PROJECT_MISMATCH !== "1") {
    console.error(`Refusing to run against ${host} (expected ${expected}.supabase.co)`);
    process.exit(1);
  }
}

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function pageAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`backtest read failed (${label}): ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const eventTime = (e: HistEvent) => new Date(`${e.event_date}T00:00:00Z`).getTime();

/** Events strictly before `weekDate` (mirrors the live engine, which never sees the future), trimmed to the trailing 365 days of that. */
function history365Before(events: HistEvent[], weekDate: Date): HistEvent[] {
  const t = weekDate.getTime();
  const since = t - 365 * MS_PER_DAY;
  return events.filter((e) => {
    const et = eventTime(e);
    return et < t && et > since;
  });
}

async function fetchEvents(admin: SupabaseClient, family: string): Promise<HistEvent[]> {
  const rows = await pageAll<{ event_date: string; qty: number }>("uk_demand_events", (from, to) =>
    admin
      .from("mrp_demand_events")
      .select("event_date, qty")
      .eq("region", "UK")
      .eq("sku", family)
      .order("id")
      .range(from, to)
  );
  return rows.map((r) => ({ event_date: r.event_date, qty: r.qty }));
}

async function fetchLegs(admin: SupabaseClient): Promise<McLegSamples> {
  const rows = await pageAll<{ leg: string; days: number }>("leg_actuals", (from, to) =>
    admin
      .from("mrp_lead_time_actuals")
      .select("leg, days")
      .in("leg", ["mfg", "ocean", "customs"])
      .order("id")
      .range(from, to)
  );
  const legs: McLegSamples = { mfg: [], ocean: [], customs: [] };
  for (const r of rows) {
    if (r.leg === "mfg") legs.mfg.push(r.days);
    else if (r.leg === "ocean") legs.ocean.push(r.days);
    else if (r.leg === "customs") legs.customs.push(r.days);
  }
  return legs;
}

/**
 * Zones-policy inputs for Part 2: ltFactor is the fixed DDMRP long-lead
 * constant used DB-wide (0.25); moq/containerQty are supplier constraints,
 * not derivable from demand history. The UK family sku carries no buffer
 * profile row itself, so these are sourced from the family's NA profile by
 * the naming convention used everywhere else in this codebase (EBH9 ->
 * EBH9NA) — an explicit, reported assumption, not silent. Falls back to 0/0
 * (no MOQ/container floor) if that row does not exist.
 */
async function fetchZoneInputs(
  admin: SupabaseClient,
  family: string
): Promise<{ moq: number; containerQty: number; source: string }> {
  const { data, error } = await admin
    .from("mrp_buffer_profile")
    .select("sku, moq, container_qty")
    .eq("sku", `${family}NA`)
    .limit(1);
  if (error) throw new Error(`backtest read failed (buffer_profile): ${error.message}`);
  if (data && data.length > 0) {
    return { moq: data[0].moq ?? 0, containerQty: data[0].container_qty ?? 0, source: data[0].sku };
  }
  return { moq: 0, containerQty: 0, source: "none found — defaulted to 0/0" };
}

const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fillRateOf = (p: PolicyResult) => (p.demandTotal === 0 ? 1 : p.demandMet / p.demandTotal);

async function main() {
  const family = process.argv[2] ?? "EBH9";
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  assertProject(url, "korylyniwsqtsvzuzydg");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Backtesting ${family} (region=UK) — READ ONLY, writes nothing to the database.`);

  const [events, legs, zoneInputs] = await Promise.all([
    fetchEvents(admin, family),
    fetchLegs(admin),
    fetchZoneInputs(admin, family),
  ]);
  console.log(`  events: ${events.length} (UK, sku=${family})`);
  console.log(`  leg actuals: mfg=${legs.mfg.length} ocean=${legs.ocean.length} customs=${legs.customs.length}`);
  console.log(`  zone inputs: moq=${zoneInputs.moq} containerQty=${zoneInputs.containerQty} (source: ${zoneInputs.source})`);

  if (events.length === 0) {
    console.error(`No UK demand events for sku=${family} — nothing to backtest.`);
    process.exit(1);
  }

  // --- CALIBRATION -------------------------------------------------------
  const trials: Trial[] = [];
  let skips = 0;
  let weeks = 0;

  for (let t = WINDOW_START.getTime(); t <= WINDOW_END.getTime(); t += 7 * MS_PER_DAY) {
    const weekDate = new Date(t);
    const week = isoDate(weekDate);
    weeks++;
    const history365 = history365Before(events, weekDate);
    const base = (history365.reduce((a, e) => a + e.qty, 0) * LEAD_DAYS) / 365;

    for (const f of POSITION_FACTORS) {
      const position = Math.round(base * f);
      const mc = simulateStockout({
        events: history365,
        now: weekDate,
        onHand: position,
        arrivals: [],
        spikes: [],
        legs,
        iterations: 2000,
        rng: mulberry32(seedFrom(`${week}:${position}`)),
      });
      if (mc === null) {
        // Honesty requirement: never silently drop a thin week — count it.
        skips++;
        continue;
      }
      const actual = demandOver(events, weekDate, LEAD_DAYS);
      trials.push({ week, predicted: mc.pStockout, stockedOut: actual > position, position });
    }
  }

  const buckets = calibrate(trials);
  const brier = brierScore(trials);

  console.log(
    `\nCalibration — ${family}, ${isoDate(WINDOW_START)}..${isoDate(WINDOW_END)} (${weeks} weekly decision points, ${POSITION_FACTORS.length} positions/week):`
  );
  console.log(`  ${"bucket".padEnd(10)}${"n".padStart(7)}${"meanPred".padStart(11)}${"observed".padStart(11)}`);
  for (const b of buckets) {
    console.log(
      `  ${`${b.loPct}-${b.hiPct}%`.padEnd(10)}${String(b.n).padStart(7)}${fmtPct(b.meanPredicted).padStart(11)}${fmtPct(b.observedRate).padStart(11)}`
    );
  }
  console.log(`\nBrier score: ${brier.toFixed(4)} (0 = perfect, 0.25 = coin flip)`);
  console.log(`Trials: ${trials.length}   Skipped (simulateStockout returned null): ${skips}`);

  // --- POLICY COMPARISON --------------------------------------------------
  const baseAtStart = (history365Before(events, WINDOW_START).reduce((a, e) => a + e.qty, 0) * LEAD_DAYS) / 365;
  const openingStock = Math.round(baseAtStart);

  const simConfig = (rngSeed: string): SimConfig => ({
    events,
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    leadDays: LEAD_DAYS,
    openingStock,
    ltFactor: 0.25,
    varFactorFor: varFactorFromCov,
    moq: zoneInputs.moq,
    containerQty: zoneInputs.containerQty,
    legs,
    rng: mulberry32(seedFrom(rngSeed)),
  });

  const zoneResult = simulateZonePolicy(simConfig(`${family}:zone`));
  const mcResults = MC_THRESHOLDS.map((th) => simulateMcPolicy(simConfig(`${family}:mc`), th));
  const policies = [zoneResult, ...mcResults];

  console.log(`\nPolicy comparison — opening stock ${openingStock} (round(expected lead-time demand) at window start):`);
  console.log(
    `  ${"policy".padEnd(10)}${"orders".padStart(7)}${"units".padStart(8)}${"fillRate".padStart(10)}${"stockoutWk".padStart(12)}${"avgOnHand".padStart(11)}${"peak".padStart(8)}`
  );
  for (const p of policies) {
    console.log(
      `  ${p.label.padEnd(10)}${String(p.orders).padStart(7)}${String(p.unitsOrdered).padStart(8)}${fmtPct(fillRateOf(p)).padStart(10)}${String(p.stockoutWeeks).padStart(12)}${p.avgOnHand.toFixed(1).padStart(11)}${String(p.peakOnHand).padStart(8)}`
    );
  }

  // --- WRITE JSON ----------------------------------------------------------
  mkdirSync("scripts/demo/out", { recursive: true });
  const outPath = `scripts/demo/out/backtest-${family.toLowerCase()}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        family,
        window: { start: isoDate(WINDOW_START), end: isoDate(WINDOW_END), weeks },
        trials: trials.length,
        skipped: skips,
        calibration: buckets,
        brier,
        policies: policies.map((p) => ({ ...p, fillRate: fillRateOf(p) })),
        // additive, beyond the plan's literal JSON shape — useful context for charting:
        openingStock,
        zoneInputs,
      },
      null,
      1
    )
  );
  console.log(`\nWrote ${outPath}`);

  // --- VERDICT ---------------------------------------------------------------
  const reliableBuckets = buckets.filter((b) => b.n >= MIN_BUCKET_N);
  const maxGap =
    reliableBuckets.length === 0
      ? null
      : Math.max(...reliableBuckets.map((b) => Math.abs(b.meanPredicted - b.observedRate)));
  const calibrationVerdict =
    maxGap === null
      ? `no bucket has n>=${MIN_BUCKET_N} — insufficient trials to judge`
      : maxGap <= ACCEPTABLE_CALIBRATION_GAP
        ? `ACCEPTABLE (max |meanPred-observed| ${fmtPct(maxGap)} <= ${fmtPct(ACCEPTABLE_CALIBRATION_GAP)} bar)`
        : `NOT ACCEPTABLE (max |meanPred-observed| ${fmtPct(maxGap)} > ${fmtPct(ACCEPTABLE_CALIBRATION_GAP)} bar)`;

  let winner = policies[0];
  let winnerMetric = -Infinity;
  for (const p of policies) {
    const fillRate = fillRateOf(p);
    const metric = p.avgOnHand === 0 ? (fillRate === 0 ? 0 : Infinity) : fillRate / p.avgOnHand;
    if (metric > winnerMetric) {
      winnerMetric = metric;
      winner = p;
    }
  }

  console.log(
    `\nVERDICT: calibration ${calibrationVerdict}. Best fill-rate-per-unit-of-average-stock: ${winner.label} (${winnerMetric.toFixed(6)} fill-fraction/unit).`
  );
}

main().catch((e) => {
  console.error("backtest failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
