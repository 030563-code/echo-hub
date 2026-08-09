/**
 * Dump the Monte Carlo lead-time-demand DISTRIBUTION for one SKU to JSON, for
 * demo visualisation. Mirrors the engine's per-SKU McInput assembly
 * (engine.ts item 10) and re-implements the iteration walk with
 * instrumentation (the library returns only the summary; the chart needs the
 * per-iteration demand). Uses the same seed derivation as the engine, so the
 * numbers here match tonight's persisted p_stockout.
 *
 * Usage: npx dotenv-cli -e .env.local -- npx tsx scripts/demo/mc-dump.ts EBH9NA
 * Writes scripts/demo/out/mc-<sku>.json.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { trailingIsoWeeks, weeklyTotals } from "../../src/lib/mrp/engine";
import {
  fitMarkov,
  jitterSize,
  mulberry32,
  seedFrom,
  triangular,
  type McLegSamples,
} from "../../src/lib/mrp/montecarlo";

const sku = process.argv[2] ?? "EBH9NA";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env");
const admin = createClient(url, key);

const MS_PER_DAY = 86_400_000;
const now = new Date();
const runDate = now.toISOString().slice(0, 10);
const since365 = new Date(now.getTime() - 365 * MS_PER_DAY).toISOString().slice(0, 10);

const LEG_SEEDS: Record<keyof McLegSamples, [number, number, number]> = {
  mfg: [45, 45, 75],
  ocean: [17, 21, 31],
  customs: [5, 9, 21],
};

async function main() {
  // Alias spellings roll into the canonical SKU exactly as the engine does.
  const { data: aliasRows } = await admin
    .from("mrp_buffer_profile")
    .select("sku")
    .eq("alias_of", sku);
  const spellings = [sku, ...(aliasRows ?? []).map((r) => r.sku)];

  // No-ETA arrivals land at the profile's DLT, exactly as the engine assumes.
  const { data: prof } = await admin.from("mrp_buffer_profile").select("dlt_days").eq("sku", sku);
  const dltDays = prof?.[0]?.dlt_days ?? 75;

  const [{ data: events }, { data: status }, { data: ships }, { data: legs }, { data: spikes }] =
    await Promise.all([
      admin
        .from("mrp_demand_events")
        .select("event_date, qty")
        .in("sku", spellings)
        .in("region", ["US", "CA"])
        .gt("event_date", since365),
      admin
        .from("mrp_buffer_status_daily")
        .select("on_hand, in_transit, on_order, p_stockout, p_stockout_ci, data_grade, red, yellow_top, green_top, nfp, zone")
        .eq("sku", sku)
        .order("run_date", { ascending: false })
        .limit(1),
      admin
        .from("shipment_contents")
        .select("qty, eta, status")
        .in("sku", spellings)
        .neq("status", "delivered"),
      admin.from("mrp_lead_time_actuals").select("leg, days").in("leg", ["mfg", "ocean", "customs"]),
      admin
        .from("mrp_spike_register")
        .select("qty, weight")
        .eq("sku", sku)
        .eq("qualified", true)
        .order("run_date", { ascending: false }),
    ]);

  const s = status?.[0];
  if (!s || !events?.length) throw new Error(`no persisted status or events for ${sku}`);

  const legSamples: McLegSamples = { mfg: [], ocean: [], customs: [] };
  for (const l of legs ?? []) legSamples[l.leg as keyof McLegSamples]?.push(l.days);

  const arrivals = (ships ?? []).map((r) => ({
    qty: r.qty,
    etaDaysFromNow: r.eta
      ? Math.max(0, Math.ceil((new Date(`${r.eta}T00:00:00Z`).getTime() - now.getTime()) / MS_PER_DAY))
      : dltDays,
  }));
  if ((s.on_order ?? 0) > 0) arrivals.push({ qty: s.on_order, etaDaysFromNow: dltDays });

  const spikeList = (spikes ?? []).slice(0, 4);

  const rng = mulberry32(seedFrom(`${runDate}:${sku}`));
  const weeks = trailingIsoWeeks(now, 52);
  const totals = weeklyTotals(events, weeks);
  const { p01, p11, lastActive } = fitMarkov(totals);
  // Mirrors montecarlo.ts: sizes are ACTIVE-WEEK TOTALS (one Markov step =
  // one week), falling back to per-event sizes only with no active week.
  let sizes = totals.filter((t) => t > 0);
  if (sizes.length === 0) sizes = events.filter((e) => e.qty > 0).map((e) => e.qty);
  const sampleLeg = (arr: number[], seed: [number, number, number]) =>
    arr.length >= 10 ? arr[Math.floor(rng() * arr.length)] : triangular(seed[0], seed[1], seed[2], rng());

  const iterations = 10_000;
  const demands: number[] = new Array(iterations);
  const avails: number[] = new Array(iterations);
  let short = 0;
  for (let i = 0; i < iterations; i++) {
    const L =
      sampleLeg(legSamples.mfg, LEG_SEEDS.mfg) +
      sampleLeg(legSamples.ocean, LEG_SEEDS.ocean) +
      sampleLeg(legSamples.customs, LEG_SEEDS.customs);
    let state = lastActive;
    let demand = 0;
    for (let w = 0; w < Math.ceil(L / 7); w++) {
      const active = rng() < (state ? p11 : p01);
      if (active && sizes.length > 0) demand += jitterSize(sizes[Math.floor(rng() * sizes.length)], rng);
      state = active;
    }
    for (const sp of spikeList) if (rng() < sp.weight) demand += sp.qty;
    let avail = s.on_hand ?? 0;
    for (const a of arrivals) if (a.etaDaysFromNow <= L) avail += a.qty;
    demands[i] = demand;
    avails[i] = avail;
    if (demand > avail) short++;
  }

  const maxD = Math.max(...demands);
  const binW = Math.max(50, Math.ceil(maxD / 40 / 50) * 50);
  const bins = new Map<number, number>();
  for (const d of demands) {
    const b = Math.floor(d / binW) * binW;
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }

  const out = {
    sku,
    runDate,
    iterations,
    pStockoutLocal: short / iterations,
    persisted: s,
    markov: { p01, p11, lastActive },
    eventCount: events.length,
    onHand: s.on_hand,
    arrivals,
    spikes: spikeList,
    binWidth: binW,
    bins: [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([lo, n]) => ({ lo, n })),
    availTypical: (s.on_hand ?? 0) + arrivals.reduce((a, x) => a + x.qty, 0),
  };
  writeFileSync(`scripts/demo/out/mc-${sku.toLowerCase()}.json`, JSON.stringify(out, null, 1));
  console.log(
    `${sku}: pLocal=${(out.pStockoutLocal * 100).toFixed(1)}% persisted=${((s.p_stockout ?? 0) * 100).toFixed(1)}% events=${events.length} bins=${out.bins.length}`
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
