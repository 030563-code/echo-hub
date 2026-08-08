/**
 * mrp-dry-run.ts — run the MRP engine READ path against live data without
 * persisting anything (no status_daily upsert, no spike register, no profile
 * write-back). Smoke check for the nightly engine.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/mrp-dry-run.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runMrpEngine } from "../src/lib/mrp/engine";
import { createSupabaseEngineData } from "../src/lib/mrp/engine-data";

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

async function main() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  assertProject(url, "korylyniwsqtsvzuzydg");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const result = await runMrpEngine(createSupabaseEngineData(admin), { dryRun: true });

  const { rows, spikes, ...summary } = result;
  console.log("summary:", JSON.stringify(summary, null, 2));
  console.log("\nper-SKU rows (dry run — NOT persisted):");
  for (const r of rows) {
    console.log(
      `  ${r.sku.padEnd(12)} zone=${r.zone.padEnd(6)} nfp=${String(r.nfp).padStart(6)} ` +
        `red=${String(r.red).padStart(4)} yTop=${String(r.yellow_top).padStart(5)} gTop=${String(r.green_top).padStart(5)} ` +
        `onHand=${r.on_hand} inTransit=${r.in_transit} onOrder=${r.on_order} firm=${r.firm_demand} ` +
        `action=${r.action_qty} buildable=${r.max_buildable ?? "null"} blocked=${r.blocked_by_materials} ` +
        `flags=${JSON.stringify(r.flags)}`
    );
  }
  console.log(`\nqualified spikes (dry run): ${spikes.length}`);
  for (const s of spikes) console.log(" ", JSON.stringify(s));
}

main().catch((e) => {
  console.error("dry run failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
