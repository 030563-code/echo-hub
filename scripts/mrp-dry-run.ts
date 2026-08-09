/**
 * mrp-dry-run.ts — run the MRP engine READ path against live data without
 * persisting anything (no status_daily upsert, no spike register, no profile
 * write-back). Smoke check for the nightly engine.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/mrp-dry-run.ts                          # read-only
 *   npx tsx --env-file=.env.local scripts/mrp-dry-run.ts --persist                # save a run
 *   npx tsx --env-file=.env.local scripts/mrp-dry-run.ts --persist --draft-pos    # + pre-draft red-zone PO chains
 *
 * --persist writes mrp_buffer_status_daily + mrp_spike_register and updates
 * measured ADU/CoV on mrp_buffer_profile. Those are SHADOW-BOARD tables: the
 * /mrp v2 section reads them for observation, and no operational decision or
 * outbound integration is driven off them until the Phase-2 cutover. It is
 * still a write to the live project, so it is opt-in rather than the default.
 *
 * --draft-pos (Task 16) additionally calls mrp_draft_po_chain (quiet mode —
 * no Slack/Xero webhooks, no po_number-generator collision) for any red SKU
 * the container fill selected. Only meaningful alongside --persist (errors
 * otherwise): a dry run computes containerFill but never has a live PO to
 * check idempotency against.
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

  const persist = process.argv.includes("--persist");
  const draftPos = process.argv.includes("--draft-pos");
  if (draftPos && !persist) {
    console.error("--draft-pos requires --persist");
    process.exit(1);
  }
  const result = await runMrpEngine(createSupabaseEngineData(admin), { dryRun: !persist, draftPos });

  const { rows, spikes, containerFill, draft, ...summary } = result;
  console.log("summary:", JSON.stringify(summary, null, 2));
  console.log(persist ? "\nper-SKU rows (PERSISTED):" : "\nper-SKU rows (dry run — NOT persisted):");
  for (const r of rows) {
    console.log(
      `  ${r.sku.padEnd(12)} zone=${r.zone.padEnd(6)} nfp=${String(r.nfp).padStart(6)} ` +
        `red=${String(r.red).padStart(4)} yTop=${String(r.yellow_top).padStart(5)} gTop=${String(r.green_top).padStart(5)} ` +
        `onHand=${r.on_hand} inTransit=${r.in_transit} onOrder=${r.on_order} firm=${r.firm_demand} ` +
        `action=${r.action_qty} buildable=${r.max_buildable ?? "null"} blocked=${r.blocked_by_materials} ` +
        `pStockout=${r.p_stockout === null ? "null" : `${(r.p_stockout * 100).toFixed(1)}%`} ` +
        `grade=${r.data_grade ?? "null"} flags=${JSON.stringify(r.flags)}`
    );
  }
  console.log(`\nqualified spikes (dry run): ${spikes.length}`);
  for (const s of spikes) console.log(" ", JSON.stringify(s));

  console.log("\ncontainer fill:");
  if (containerFill) {
    console.log(
      `  capacity=${containerFill.cbmCapacity} used=${containerFill.cbmUsed.toFixed(2)} lines=${containerFill.lines.length} dropped=${containerFill.dropped.length}`
    );
    for (const l of containerFill.lines) {
      console.log(`   ${l.sku.padEnd(12)} qty=${String(l.qty).padStart(6)} cbm=${l.cbm.toFixed(2)}`);
    }
    for (const d of containerFill.dropped) {
      console.log(`   dropped ${d.sku} (${d.reason})`);
    }
  } else {
    console.log("  (none)");
  }

  console.log(
    `\ndraft: attempted=${draft.attempted} result=${draft.attempted ? JSON.stringify(draft.result) : "n/a"}`
  );
}

main().catch((e) => {
  console.error("dry run failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
