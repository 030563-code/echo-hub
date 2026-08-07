/**
 * backfill-mcs-demand.ts — backfill ~15 years of UK/OZ SALES history from the
 * MCS mirror into ops.mrp_demand_events (source='mcs_invoice').
 *
 * Source: MCS mirror mcs_invoiceitem ⋈ mcs_invoicehdr, itype='S' only.
 *         itype 'F' is HIRE (fleet utilization, not consumption) and must
 *         NEVER enter the demand ledger. Other itypes (T/X/C/R/E/G/…) are
 *         transport/misc/credit lines — also excluded.
 * Target: ops mrp_demand_events (event_date, sku, qty, region, source,
 *         source_ref) with unique(source, source_ref, sku).
 *
 * SKU vocabulary (documented decision):
 *   NA rows in the ledger carry NA depot SKUs (EBH9NA, …); UK/OZ rows carry
 *   CANONICAL INTERNAL SKUs (product_code_master.internal_sku: EBH9, NDS, …);
 *   the MRP engine's family map reconciles the two vocabularies.
 *
 * Mapping path (join-rate evidence, probed 2026-08-07 on the live mirror):
 *   1. product_code_master.code_uk IS a real match for the UK '01-*' item
 *      codes (01-EBH9→EBH9, 01-EBH8→EBH8, 01-EBH10→EBH10, 01-NDS→NDS,
 *      01-NDT→DBRT, 01-HT3.5S→EU3.5, …): 1,606 / 8,143 UK sale rows joined.
 *      By UNIT volume that is only ~6.7% (26,820 / 402,689) because UK 'S'
 *      volume is dominated by non-product recharge codes (SRORC datatags /
 *      royalty recharges 164k units, FK fitting kits 96.5k, MISC 20k, …).
 *      product_code_master has NO Australia column, so the code_uk join
 *      matches 0 OZ rows.
 *   2. Therefore a small explicit ITEM_ALIASES table (below) supplements the
 *      dynamic code_uk join for item codes that are demonstrably products but
 *      absent from the master's region columns — each entry descr-verified
 *      against the mirror. With aliases, coverage of genuine BARRIER-PRODUCT
 *      volume is near-complete (UK 2,143 invoice-sku rows / 69,609 units
 *      2011→2026; OZ 387 rows / 12,426 units 2012→2026 at probe time).
 *   3. Everything else (fitting kits, clips, misc, freight, services,
 *      recharges) is SKIPPED and counted — no invented mappings.
 *
 * ITEM_ALIASES evidence (from mirror descr distributions):
 *   EBHS      → EBH9  "Echo Barrier H Series" (generic H-series; both
 *                     branches; H9 is the flagship — <3% of EBHS unit volume
 *                     mentions H10/H8/H3/H4 in descr; the family map absorbs
 *                     the residual noise). OZ's dominant product code.
 *   01-EBH9L  → EBH9  "Echo Barrier H9 With Customer logo / in Black"
 *   01-EBH8L  → EBH8  "Echo Barrier H8 With Customer Logo"
 *   ND        → NDS   "Budget Acoustic Barrier" / "Noise Defender …"
 *   ECB       → BUN   "Echo Barrier Bungies" (master product 'Bungies')
 *   VFK       → VFK   "Vertical Fitting Kit" (master product exists — unlike
 *                     FK, which has no master entry and stays skipped)
 *   V1        → V1    OZ "Echo Barrier V1 Acoustic Barrier & Folding Frame"
 *   DELINFO is excluded from the code_uk join: it is a delivery-info
 *   pseudo-code in the master, not product demand.
 *
 * Join & idempotency mechanics:
 *   - hdr join on (branch, invno) ONLY. Verified on the mirror: (branch,
 *     invno) is globally unique in mcs_invoicehdr (0 collisions, 0 fractional
 *     invno) while invcprefix is inconsistently null-vs-'' between item and
 *     hdr rows and would orphan 27 sale rows if included in the join.
 *   - source_ref = `${branch}-${invno}` (e.g. 'UK-12345').
 *   - qty is SUMMED per (invoice, canonical sku) BEFORE insert (an invoice
 *     can carry several lines mapping to one sku), so the ledger row is the
 *     invoice's total and unique(source, source_ref, sku) is satisfied.
 *   - insert is upsert with ignoreDuplicates (ON CONFLICT DO NOTHING):
 *     re-runs insert 0 and never mutate existing rows.
 *   - quant <= 0 lines (credits/zero lines) are excluded and counted; the
 *     ledger's qty>0 check would reject them and do-nothing semantics cannot
 *     net credits anyway. Known limitation: demand is slightly overstated by
 *     un-netted credit notes.
 *
 * Run:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   MCS_SUPABASE_URL=... MCS_SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx scripts/backfill-mcs-demand.ts
 *
 * NOTE: the initial backfill (2026-08-07) was executed via MCP execute_sql
 * with logic identical to this script (MCS extraction pages → batched
 * INSERT … jsonb_to_recordset … ON CONFLICT DO NOTHING on ops) because the
 * MCS mirror service key is not present in .env.local. This script is the
 * committed, reproducible artifact for re-runs once MCS keys are available.
 */
import { createClient } from "@supabase/supabase-js";

const OPS_REF = "korylyniwsqtsvzuzydg"; // ops (write target)
const MCS_REF = "rmphqdopzvmirlooqnkv"; // MCS mirror (READ-ONLY source)

// Item codes that are genuine products but absent from product_code_master's
// region code columns. Values are canonical internal SKUs and are validated
// against product_code_master.internal_sku at runtime. Evidence in header.
const ITEM_ALIASES: Record<string, string> = {
  EBHS: "EBH9",
  "01-EBH9L": "EBH9",
  "01-EBH8L": "EBH8",
  ND: "NDS",
  ECB: "BUN",
  VFK: "VFK",
  V1: "V1",
};

// Master pseudo-codes that must never produce demand rows.
const EXCLUDED_INTERNAL_SKUS = new Set(["DELINFO"]);

const BRANCH_TO_REGION: Record<string, string> = { UK: "UK", OZ: "OZ" };

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}`);
    process.exit(1);
  }
  return v;
}

function assertRef(url: string, expected: string, label: string) {
  const host = new URL(url).host; // <ref>.supabase.co
  if (!host.startsWith(`${expected}.`) && process.env.ALLOW_PROJECT_MISMATCH !== "1") {
    console.error(
      `${label} URL points at ${host}, expected project ${expected}. ` +
        `Set ALLOW_PROJECT_MISMATCH=1 to override (e.g. staging).`
    );
    process.exit(1);
  }
}

type HdrRow = { branch: string; invno: number; invdate: string };
type ItemRow = { branch: string; invno: number; item: string | null; quant: number | null };

async function main() {
  const opsUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const opsKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const mcsUrl = env("MCS_SUPABASE_URL");
  const mcsKey = env("MCS_SUPABASE_SERVICE_ROLE_KEY");
  assertRef(opsUrl, OPS_REF, "ops");
  assertRef(mcsUrl, MCS_REF, "MCS");

  const ops = createClient(opsUrl, opsKey, { auth: { persistSession: false } });
  const mcs = createClient(mcsUrl, mcsKey, { auth: { persistSession: false } });

  // --- 1. Item-code -> canonical internal SKU map --------------------------
  const { data: master, error: pcmErr } = await ops
    .from("product_code_master")
    .select("internal_sku, code_uk");
  if (pcmErr) throw new Error(`ops product_code_master: ${pcmErr.message}`);
  const internalSkus = new Set<string>();
  const itemToSku = new Map<string, string>();
  for (const row of (master ?? []) as { internal_sku: string | null; code_uk: string | null }[]) {
    const sku = row.internal_sku?.trim();
    if (!sku || EXCLUDED_INTERNAL_SKUS.has(sku)) continue;
    internalSkus.add(sku);
    if (row.code_uk?.trim()) itemToSku.set(row.code_uk.trim(), sku);
  }
  for (const [item, sku] of Object.entries(ITEM_ALIASES)) {
    if (!internalSkus.has(sku)) {
      throw new Error(`alias ${item} -> ${sku}: target SKU not in product_code_master`);
    }
    itemToSku.set(item, sku); // aliases win over code_uk on collision (none known)
  }
  console.log(`item-code map: ${itemToSku.size} codes -> ${internalSkus.size} canonical SKUs`);

  const PAGE = 1000;

  // --- 2. Invoice headers: (branch, invno) -> invoice date ------------------
  // (branch, invno) verified unique on the mirror; guard anyway.
  const hdrDate = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await mcs
      .from("mcs_invoicehdr")
      .select("branch, invno, invdate")
      .order("branch", { ascending: true })
      .order("invno", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`mcs_invoicehdr: ${error.message}`);
    for (const h of (data ?? []) as HdrRow[]) {
      const key = `${h.branch}-${h.invno}`;
      const prev = hdrDate.get(key);
      if (prev !== undefined && prev !== h.invdate) {
        throw new Error(`duplicate header key ${key} with differing invdate — aborting`);
      }
      hdrDate.set(key, h.invdate);
    }
    if (!data || data.length < PAGE) break;
  }
  console.log(`invoice headers: ${hdrDate.size}`);

  // --- 3. Sale items -> aggregated (invoice, sku) demand events -------------
  let skippedNonPositive = 0;
  let skippedNoHeader = 0;
  let skippedBadBranch = 0;
  const skippedItems = new Map<string, { rows: number; units: number }>();
  // key `${source_ref}|${sku}`
  const events = new Map<
    string,
    { event_date: string; sku: string; qty: number; region: string; source_ref: string }
  >();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await mcs
      .from("mcs_invoiceitem")
      .select("branch, invno, item, quant")
      .eq("itype", "S") // sales ONLY — 'F' (hire) must never enter the ledger
      .order("branch", { ascending: true })
      .order("invno", { ascending: true })
      .order("counter", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`mcs_invoiceitem: ${error.message}`);

    for (const it of (data ?? []) as ItemRow[]) {
      const qty = Number(it.quant);
      if (!Number.isFinite(qty) || qty <= 0) {
        skippedNonPositive++;
        continue;
      }
      const region = BRANCH_TO_REGION[it.branch];
      if (!region) {
        skippedBadBranch++;
        continue;
      }
      const item = (it.item ?? "").trim();
      const sku = itemToSku.get(item);
      if (!sku) {
        const s = skippedItems.get(item || "(blank)") ?? { rows: 0, units: 0 };
        s.rows++;
        s.units += qty;
        skippedItems.set(item || "(blank)", s);
        continue;
      }
      const sourceRef = `${it.branch}-${it.invno}`;
      const invdate = hdrDate.get(sourceRef);
      if (!invdate) {
        skippedNoHeader++;
        continue;
      }
      const key = `${sourceRef}|${sku}`;
      const existing = events.get(key);
      if (existing) existing.qty += qty;
      else
        events.set(key, {
          event_date: invdate.slice(0, 10), // timestamp -> date
          sku,
          qty,
          region,
          source_ref: sourceRef,
        });
    }
    if (!data || data.length < PAGE) break;
  }
  console.log(`aggregated demand events: ${events.size}`);

  // --- 4. Idempotent batched insert (ON CONFLICT DO NOTHING) ----------------
  const rows = [...events.values()].map((e) => ({ ...e, source: "mcs_invoice" }));
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await ops.from("mrp_demand_events").upsert(rows.slice(i, i + BATCH), {
      onConflict: "source,source_ref,sku",
      ignoreDuplicates: true, // DO NOTHING — never mutate existing ledger rows
    });
    if (error) throw new Error(`mrp_demand_events upsert: ${error.message}`);
  }

  // --- 5. Report ------------------------------------------------------------
  const perRegion = new Map<string, { rows: number; units: number; min: string; max: string }>();
  const perSku = new Map<string, number>();
  for (const r of rows) {
    const reg = perRegion.get(r.region) ?? { rows: 0, units: 0, min: r.event_date, max: r.event_date };
    reg.rows++;
    reg.units += r.qty;
    if (r.event_date < reg.min) reg.min = r.event_date;
    if (r.event_date > reg.max) reg.max = r.event_date;
    perRegion.set(r.region, reg);
    perSku.set(r.sku, (perSku.get(r.sku) ?? 0) + r.qty);
  }
  console.log(`upserted (attempted): ${rows.length} rows`);
  for (const [region, s] of [...perRegion.entries()].sort()) {
    console.log(`  ${region}: ${s.rows} rows, ${s.units} units, ${s.min} -> ${s.max}`);
  }
  console.log(`units by canonical SKU:`);
  for (const [sku, units] of [...perSku.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sku}: ${units}`);
  }
  console.log(
    `skipped: ${skippedNonPositive} non-positive-qty lines, ` +
      `${skippedNoHeader} mapped lines without header, ${skippedBadBranch} unknown-branch lines`
  );
  const topSkipped = [...skippedItems.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, 10);
  console.log(`top 10 skipped item codes by unit volume (no product_code_master match — not mapped):`);
  for (const [item, s] of topSkipped) console.log(`  ${item}: ${s.rows} rows, ${s.units} units`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
