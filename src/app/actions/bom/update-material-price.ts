"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createMfgClient } from "@/lib/supabase/mfg";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { externalCallsDisabled } from "@/lib/env";

// ---------------------------------------------------------------------------
// Edit MATERIAL prices in the Hub price master (mfg.material_prices) — one price
// per material, applied across every product that uses it (the BOM explosion +
// master view price from here, NOT the snapshot). Replaces the per-product
// component editor. Quantities are NOT editable here (the recipe is read-only).
// bom.edit gated; mfg write via service-role AFTER the gate; audited to ops
// bom_edit_log (model_code = MATERIAL:<code>).
// ---------------------------------------------------------------------------

const Schema = z.object({
  edits: z
    .array(
      z.object({
        material_code: z.string().trim().min(1).max(100),
        unit_price_eur: z.number().nonnegative().max(1_000_000),
      })
    )
    .min(1, "Nothing to save")
    .max(200),
});

export type UpdateMaterialPricesInput = z.infer<typeof Schema>;
export type UpdateMaterialPricesResult =
  | { success: true; updated: number; missing: number }
  | { success: false; error: string };

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

export async function updateMaterialPrices(input: UpdateMaterialPricesInput): Promise<UpdateMaterialPricesResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("bom.edit")) {
    return { success: false, error: "Forbidden: missing bom.edit capability" };
  }

  if (externalCallsDisabled()) {
    return { success: false, error: "Sandbox (staging): edits to the live manufacturing price master are disabled." };
  }

  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (!process.env.MFG_SUPABASE_URL || !process.env.MFG_SUPABASE_SERVICE_ROLE_KEY) {
    return { success: false, error: "Manufacturing data source not configured." };
  }

  const edits = parsed.data.edits;
  const mfg = createMfgClient();

  // "Before" prices for the audit log.
  const codes = edits.map((e) => e.material_code);
  const { data: before } = await mfg.from("material_prices").select("material_code, unit_price_eur").in("material_code", codes);
  const beforeByCode = new Map(
    (before ?? []).map((r) => [(r as { material_code: string }).material_code, (r as { unit_price_eur: unknown }).unit_price_eur])
  );

  const { data: latest } = await mfg
    .from("bom_weekly_snapshot")
    .select("week_start_date")
    .order("week_start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const week = latest?.week_start_date ?? null;

  const label = auth.user.email ?? "Hub user";
  const nowIso = new Date().toISOString();

  // UPDATE (not upsert) so description/currency are never wiped; every editable
  // material already exists in the master (the list is sourced from it). .select()
  // returns the affected rows so we know deterministically which committed.
  const succeeded: typeof edits = [];
  for (const e of edits) {
    const { data: rows, error } = await mfg
      .from("material_prices")
      .update({ unit_price_eur: round4(e.unit_price_eur), updated_at: nowIso, updated_by_uid: auth.user.id, updated_by_label: label })
      .eq("material_code", e.material_code)
      .select("material_code");
    if (error) {
      console.error("updateMaterialPrices failed", e.material_code, error.message);
      continue;
    }
    if (rows && rows.length > 0) succeeded.push(e);
  }

  // Audit (ops, service-role) — ONLY the edits that actually committed, so the
  // financial trail never records a price change that didn't happen. Best-effort.
  if (succeeded.length) {
    try {
      await createAdminClient()
        .from("bom_edit_log")
        .insert(
          succeeded.map((e) => ({
            model_code: `MATERIAL:${e.material_code}`,
            week_start_date: week,
            edited_by: auth.user.id,
            edited_by_label: label,
            before: { unit_price_eur: beforeByCode.get(e.material_code) ?? null },
            after: { unit_price_eur: round4(e.unit_price_eur) },
          }))
        );
    } catch (e) {
      console.error("bom_edit_log insert (material) failed", e);
    }
  }

  revalidatePath("/bom");
  return { success: true, updated: succeeded.length, missing: edits.length - succeeded.length };
}
