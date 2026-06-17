"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createMfgClient } from "@/lib/supabase/mfg";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Edit a master BOM row in the mfg project (Decision: editing targets the master
// bom_weekly_snapshot.component_detail; the PO explosion reads it live).
//
// Security: `bom.edit` is checked here (ops capability). mfg has no auth users, so
// the write goes through the mfg SERVICE-ROLE client AFTER that gate — the
// established "privileged service-role write after a server-side capability check"
// pattern. Every edit is written to the ops `bom_edit_log` (before/after) so the
// price history a spreadsheet can't keep is captured.
//
// Recomputes the derived fields so the row stays internally consistent:
//   component.extended_eur = unit_cost_eur × qty
//   bamida_total_eur       = bamida_man_eur + bamida_print_eur
//   sro_total_eur          = sro_components_eur + sro_duty_8pct_eur + sro_admin_eur
//   bom_total_eur          = bamida_total_eur + sro_total_eur
// ---------------------------------------------------------------------------

const ComponentSchema = z.object({
  code: z.string().trim().min(1, "Component code required"),
  desc: z.string().trim().max(200).nullish(),
  qty: z.number().nonnegative().max(100000),
  currency: z.string().trim().max(8).nullish(),
  dutiable: z.boolean().default(false),
  unit_cost_eur: z.number().nonnegative().max(1_000_000),
});

const UpdateBomSchema = z.object({
  modelCode: z.string().trim().min(1),
  components: z.array(ComponentSchema).max(200),
  bamida_man_eur: z.number().nonnegative().max(1_000_000),
  bamida_print_eur: z.number().nonnegative().max(1_000_000),
  sro_components_eur: z.number().nonnegative().max(1_000_000),
  sro_duty_8pct_eur: z.number().nonnegative().max(1_000_000),
  sro_admin_eur: z.number().nonnegative().max(1_000_000),
});

export type UpdateBomInput = z.infer<typeof UpdateBomSchema>;

export type UpdateBomResult = { success: true } | { success: false; error: string };

const round = (v: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

export async function updateBomComponentDetail(input: UpdateBomInput): Promise<UpdateBomResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("bom.edit")) {
    return { success: false, error: "Forbidden: missing bom.edit capability" };
  }

  const parsed = UpdateBomSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  if (!process.env.MFG_SUPABASE_URL || !process.env.MFG_SUPABASE_SERVICE_ROLE_KEY) {
    return { success: false, error: "Manufacturing data source not configured." };
  }

  // Normalise component_detail: recompute extended_eur from unit_cost × qty.
  const componentDetail = d.components.map((c) => ({
    code: c.code,
    desc: c.desc ?? null,
    qty: c.qty,
    currency: c.currency ?? "EUR",
    dutiable: c.dutiable,
    unit_cost_eur: round(c.unit_cost_eur),
    extended_eur: round(c.unit_cost_eur * c.qty),
  }));

  const bamidaTotal = round(d.bamida_man_eur + d.bamida_print_eur);
  const sroTotal = round(d.sro_components_eur + d.sro_duty_8pct_eur + d.sro_admin_eur);
  const bomTotal = round(bamidaTotal + sroTotal);

  const mfg = createMfgClient();

  // Latest week + the current row (for the audit "before" + the row id).
  const { data: latest } = await mfg
    .from("bom_weekly_snapshot")
    .select("week_start_date")
    .order("week_start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const week = latest?.week_start_date ?? null;
  if (!week) return { success: false, error: "No BOM snapshot week found." };

  const { data: current } = await mfg
    .from("bom_weekly_snapshot")
    .select(
      "id, component_detail, bamida_man_eur, bamida_print_eur, bamida_total_eur, sro_components_eur, sro_duty_8pct_eur, sro_admin_eur, sro_total_eur, bom_total_eur"
    )
    .eq("week_start_date", week)
    .eq("model_code", d.modelCode)
    .maybeSingle();

  if (!current) {
    return { success: false, error: `No BOM row for ${d.modelCode} in the latest week.` };
  }

  const update = {
    component_detail: componentDetail,
    bamida_man_eur: round(d.bamida_man_eur),
    bamida_print_eur: round(d.bamida_print_eur),
    bamida_total_eur: bamidaTotal,
    sro_components_eur: round(d.sro_components_eur),
    sro_duty_8pct_eur: round(d.sro_duty_8pct_eur),
    sro_admin_eur: round(d.sro_admin_eur),
    sro_total_eur: sroTotal,
    bom_total_eur: bomTotal,
  };

  const { error: upErr } = await mfg
    .from("bom_weekly_snapshot")
    .update(update)
    .eq("id", (current as { id: number }).id);

  if (upErr) {
    console.error("updateBomComponentDetail mfg update failed", upErr.message);
    return { success: false, error: "Failed to save the BOM. Please try again." };
  }

  // Audit trail (ops, service role). Best-effort — the edit already succeeded.
  try {
    const label = auth.user.email ?? "Hub user";
    await createAdminClient()
      .from("bom_edit_log")
      .insert({
        model_code: d.modelCode,
        week_start_date: week,
        edited_by: auth.user.id,
        edited_by_label: label,
        before: current,
        after: { ...update },
      });
  } catch (e) {
    console.error("bom_edit_log insert failed", e);
  }

  revalidatePath("/bom");
  return { success: true };
}
