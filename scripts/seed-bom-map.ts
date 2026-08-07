/**
 * seed-bom-map.ts — seed ops.mrp_bom_map from the mfg project's BOM snapshots.
 *
 * Source: mfg bom_weekly_snapshot (latest week_start_date per model_code),
 *         component_detail jsonb array of {code, desc, qty, ...}.
 * Target: ops mrp_bom_map (finished_sku, component_code) -> qty_per.
 *
 * model_code -> finished_sku join (documented):
 *   1. NA depot SKUs: ops po_product_catalog.bom_model_code — the same
 *      data-driven join src/lib/bom.ts uses for BOM explosion. One model can
 *      back several SKUs (e.g. H9 -> EBH9NA + EBH9ERNA).
 *   2. SK/SRO SKUs: the constant map below — 1:1 with the 22 mfg model codes,
 *      same vocabulary as VALID_SKUS in src/app/(dashboard)/mrp/actions.ts and
 *      the SKU name map in src/app/(dashboard)/transport/actions.ts.
 *   product_code_master.internal_sku is deliberately NOT the key here. The
 *   demand ledger carries TWO SKU vocabularies: NA rows use NA depot SKUs
 *   (EBH9NA, ...), while UK/OZ rows (source='mcs_invoice', backfilled by
 *   scripts/backfill-mcs-demand.ts) use canonical internal SKUs (EBH9, BUN,
 *   NDS, ...) — the engine's family map reconciles the two. The original
 *   observation (internal_sku absent from demand data) held only for NA
 *   demand and justified not keying THIS map on product_code_master; the
 *   NA/SK vocabulary used here is what Bamida-buildability joins against.
 *
 * All components with qty > 0 and a non-empty code are included — fee /
 * transport pseudo-components (GRP-SLTF, ACI-TRNS, ...) too. The Kamil
 * mapping session decides which rows map to bamida_material_stock and flips
 * verified=true; unmapped rows simply never constrain max_buildable.
 *
 * Re-runnable: existing bamida_item_name / verified values are PRESERVED
 * (human mapping wins over auto-suggestion). Rows whose component vanished
 * from the BOM are never deleted; staleness is PERSISTED via last_seen_week
 * (only rows still present in the latest snapshot get bumped) and also
 * warned on the console.
 *
 * Run:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   MFG_SUPABASE_URL=... MFG_SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx scripts/seed-bom-map.ts
 */
import { createClient } from "@supabase/supabase-js";

const OPS_REF = "korylyniwsqtsvzuzydg"; // ops (target)
const MFG_REF = "cdkpczinzhykcdbfoobn"; // mfg (read-only source)

// SK/SRO finished SKUs -> mfg bom_weekly_snapshot.model_code (1:1, complete).
const SK_SKU_TO_MODEL: Record<string, string> = {
  EBH9SK: "H9",
  EBH10SK: "H10",
  EBH9WSK: "H9W",
  EBH9X21SK: "H9X 2.1W",
  EBH9X15SK: "H9X 1.5W",
  EBH8SK: "H8",
  EBHT35SK: "HT3.5",
  EBH9JAPSK: "H9Japan",
  EBH10JAPSK: "H10Japan",
  EBH10HBSK: "H10HercBlack",
  EBH9MINISK: "H9Mini",
  EBH8MINISK: "H8Mini",
  HERASSK: "HERAS",
  NDS200SK: "NDS200",
  NDTSK: "NDT",
  CSFSSR: "CSFullSize",
  CSCSSR: "CSCompact",
  CSPTSK: "CSPlusTunnel",
  CSPWSK: "CSPlusW",
  V2SK: "V2",
  M1SK: "M1",
  GENEXTSK: "GenExtension",
};

// Conservative auto-suggestions component_code -> bamida_material_stock.item_name.
// Only matches we'd bet on; applied with verified=false and only when the exact
// item_name exists in bamida_material_stock. Everything else is left to Kamil.
const AUTO_SUGGEST: Record<string, string> = {
  // "Accoustic InfillSenizol T40" — the single acoustic-foam line in the
  // 112-row bamida list, 40 mm thickness matches T40.
  "ACI-T40": "Akustická pena S 000-040 600/600/40",
};

type ComponentDetail = { code?: unknown; desc?: unknown; qty?: unknown };
type SnapshotRow = {
  model_code: string;
  week_start_date: string;
  component_detail: ComponentDetail[] | null;
};

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
  if (host !== `${expected}.supabase.co` && process.env.ALLOW_PROJECT_MISMATCH !== "1") {
    console.error(
      `${label} URL points at ${host}, expected project ${expected}. ` +
        `Set ALLOW_PROJECT_MISMATCH=1 to override (e.g. staging).`
    );
    process.exit(1);
  }
}

async function main() {
  const opsUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const opsKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const mfgUrl = env("MFG_SUPABASE_URL");
  const mfgKey = env("MFG_SUPABASE_SERVICE_ROLE_KEY");
  assertRef(opsUrl, OPS_REF, "ops");
  assertRef(mfgUrl, MFG_REF, "mfg");

  const ops = createClient(opsUrl, opsKey, { auth: { persistSession: false } });
  const mfg = createClient(mfgUrl, mfgKey, { auth: { persistSession: false } });

  // --- 1. Latest snapshot per model_code (paged, ordered week desc) ---------
  const latestByModel = new Map<string, SnapshotRow>();
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await mfg
      .from("bom_weekly_snapshot")
      .select("model_code, week_start_date, component_detail")
      .order("week_start_date", { ascending: false })
      .order("model_code", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`mfg bom_weekly_snapshot: ${error.message}`);
    for (const row of (data ?? []) as SnapshotRow[]) {
      if (!latestByModel.has(row.model_code)) latestByModel.set(row.model_code, row);
    }
    if (!data || data.length < PAGE) break;
  }
  console.log(`mfg models: ${latestByModel.size}`);

  // --- 2. model -> finished SKUs -------------------------------------------
  const modelToSkus = new Map<string, string[]>();
  const addAlias = (model: string, sku: string) => {
    const list = modelToSkus.get(model) ?? [];
    if (!list.includes(sku)) list.push(sku);
    modelToSkus.set(model, list);
  };
  for (const [sku, model] of Object.entries(SK_SKU_TO_MODEL)) addAlias(model, sku);

  const { data: catalog, error: catErr } = await ops
    .from("po_product_catalog")
    .select("sku, bom_model_code");
  if (catErr) throw new Error(`ops po_product_catalog: ${catErr.message}`);
  const noBomCatalog: string[] = [];
  for (const c of (catalog ?? []) as { sku: string; bom_model_code: string | null }[]) {
    if (c.bom_model_code) addAlias(c.bom_model_code, c.sku);
    else noBomCatalog.push(c.sku);
  }

  // --- 3. Explode component_detail into (finished_sku, component) rows ------
  let skippedBadQty = 0;
  let skippedNoCode = 0;
  const unmatchedModels: string[] = [];
  // key `${sku}\u0000${code}` -> row
  const target = new Map<
    string,
    {
      finished_sku: string;
      component_code: string;
      component_desc: string | null;
      qty_per: number;
      last_seen_week: string;
    }
  >();
  for (const [model, snap] of latestByModel) {
    const skus = modelToSkus.get(model);
    if (!skus?.length) {
      unmatchedModels.push(model);
      continue;
    }
    for (const comp of snap.component_detail ?? []) {
      const code = typeof comp.code === "string" ? comp.code.trim() : "";
      const qty = Number(comp.qty);
      if (!code) {
        skippedNoCode++;
        continue;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        skippedBadQty++;
        continue;
      }
      const desc = typeof comp.desc === "string" ? comp.desc : null;
      for (const sku of skus) {
        const key = `${sku}\u0000${code}`;
        const existing = target.get(key);
        // Duplicate component code inside one BOM: qty adds up (MIN over
        // stock/qty_per stays correct).
        if (existing) existing.qty_per += qty;
        else
          target.set(key, {
            finished_sku: sku,
            component_code: code,
            component_desc: desc,
            qty_per: qty,
            last_seen_week: snap.week_start_date,
          });
      }
    }
  }

  // --- 4. Auto-suggest bamida matches (guarded by exact item_name existence) -
  const { data: bamida, error: bamErr } = await ops
    .from("bamida_material_stock")
    .select("item_name");
  if (bamErr) throw new Error(`ops bamida_material_stock: ${bamErr.message}`);
  const bamidaNames = new Set(((bamida ?? []) as { item_name: string }[]).map((b) => b.item_name));
  const suggestions = new Map<string, string>(); // component_code -> item_name
  for (const [code, itemName] of Object.entries(AUTO_SUGGEST)) {
    if (bamidaNames.has(itemName)) suggestions.set(code, itemName);
    else console.warn(`auto-suggest for ${code} skipped — item_name not found in bamida_material_stock`);
  }

  // --- 5. Merge with existing rows (preserve human mapping), upsert ---------
  type ExistingRow = {
    finished_sku: string;
    component_code: string;
    bamida_item_name: string | null;
    verified: boolean;
  };
  // Paged like the step-1 mfg read: the Supabase default 1000-row cap would
  // otherwise treat rows past the cap as absent and silently clobber
  // human-set bamida_item_name / verified values on re-seed.
  const existingRows: ExistingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await ops
      .from("mrp_bom_map")
      .select("finished_sku, component_code, bamida_item_name, verified")
      .order("finished_sku", { ascending: true })
      .order("component_code", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`ops mrp_bom_map read: ${error.message}`);
    existingRows.push(...((data ?? []) as ExistingRow[]));
    if (!data || data.length < PAGE) break;
  }
  const existing = new Map(existingRows.map((r) => [`${r.finished_sku}\u0000${r.component_code}`, r]));

  let autoFilled = 0;
  const upsertRows = [...target.entries()].map(([key, row]) => {
    const prev = existing.get(key);
    let bamida_item_name = prev?.bamida_item_name ?? null;
    if (!bamida_item_name && suggestions.has(row.component_code)) {
      bamida_item_name = suggestions.get(row.component_code)!;
      autoFilled++;
    }
    return {
      ...row,
      bamida_item_name,
      verified: prev?.verified ?? false,
      updated_at: new Date().toISOString(),
    };
  });

  const CHUNK = 200;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    const { error } = await ops
      .from("mrp_bom_map")
      .upsert(upsertRows.slice(i, i + CHUNK), { onConflict: "finished_sku,component_code" });
    if (error) throw new Error(`ops mrp_bom_map upsert: ${error.message}`);
  }

  const stale = [...existing.keys()].filter((k) => !target.has(k));

  // --- 6. Report ------------------------------------------------------------
  const perSku = new Map<string, number>();
  for (const r of upsertRows) perSku.set(r.finished_sku, (perSku.get(r.finished_sku) ?? 0) + 1);
  console.log(`finished SKUs seeded: ${perSku.size}`);
  for (const [sku, n] of [...perSku.entries()].sort()) console.log(`  ${sku}: ${n} components`);
  console.log(`rows upserted: ${upsertRows.length}`);
  console.log(`skipped (no/empty code): ${skippedNoCode}, skipped (qty<=0/NaN): ${skippedBadQty}`);
  console.log(`unmatched mfg models: ${unmatchedModels.length ? unmatchedModels.join(", ") : "none"}`);
  console.log(`catalog SKUs without bom_model_code (no BOM): ${noBomCatalog.sort().join(", ") || "none"}`);
  console.log(`auto-suggested bamida matches filled: ${autoFilled} rows (all verified=false)`);
  if (stale.length) {
    console.warn(
      `stale rows in mrp_bom_map no longer in the latest BOM (NOT deleted; ` +
        `their last_seen_week stays behind - query for lagging weeks):`
    );
    for (const k of stale) console.warn(`  ${k.replace("\u0000", " / ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
