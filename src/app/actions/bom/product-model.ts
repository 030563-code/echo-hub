"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { currentProductModel, isKnownProductCode, latestBomModels } from "@/lib/bom";

// ---------------------------------------------------------------------------
// Which manufacturing model a product code is costed as (bom_product_model).
// Dean, 24 Sep 2026: "allow them to edit these manully under BOM". bom.edit
// gated; written with the service role after the gate; audited to ops
// bom_edit_log (model_code = PRODUCT:<code>). An order approved from then on
// freezes with the new model; one approved already keeps its cost until it is
// re-costed (recost-sro-order.ts).
// ---------------------------------------------------------------------------

const Schema = z.object({
  sku: z.string().trim().min(1).max(40),
  // Null takes the Hub's choice away, and the product tables decide again.
  model_code: z.string().trim().min(1).max(60).nullable(),
});

export type SaveProductModelInput = z.infer<typeof Schema>;
export type SaveProductModelResult = { success: true } | { success: false; error: string };

export async function saveProductModel(input: SaveProductModelInput): Promise<SaveProductModelResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("bom.edit")) {
    return { success: false, error: "Forbidden: missing bom.edit capability" };
  }

  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { sku, model_code } = parsed.data;

  try {
    const [known, bom, before] = await Promise.all([isKnownProductCode(sku), latestBomModels(), currentProductModel(sku)]);
    if (!known) return { success: false, error: `${sku} is not a product code the Hub knows.` };
    if (model_code && !bom.models.has(model_code)) {
      return { success: false, error: `The bill of materials has no model called ${model_code}.` };
    }
    if (before.chosen === model_code) return { success: true };

    const admin = createAdminClient();
    const label = auth.user.email ?? "Hub user";
    const { error } = model_code
      ? await admin
          .from("bom_product_model")
          .upsert(
            { sku, model_code, updated_by: auth.user.id, updated_by_label: label, updated_at: new Date().toISOString() },
            { onConflict: "sku" },
          )
      : await admin.from("bom_product_model").delete().eq("sku", sku);
    if (error) {
      console.error("saveProductModel failed", sku, error.message);
      return { success: false, error: "Could not save the model." };
    }

    // Only a change that committed reaches the trail.
    const { error: auditError } = await admin.from("bom_edit_log").insert({
      model_code: `PRODUCT:${sku}`,
      week_start_date: bom.week,
      edited_by: auth.user.id,
      edited_by_label: label,
      before: { model_code: before.chosen ?? before.listed, chosen_in_hub: before.chosen !== null },
      after: { model_code: model_code ?? before.listed, chosen_in_hub: model_code !== null },
    });
    if (auditError) console.error("bom_edit_log insert (product model) failed", auditError.message);
  } catch (e) {
    console.error("saveProductModel failed", sku, e);
    return { success: false, error: "Could not save the model." };
  }

  revalidatePath("/bom");
  return { success: true };
}
