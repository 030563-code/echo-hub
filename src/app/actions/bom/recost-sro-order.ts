"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { recostSroPo } from "@/lib/bom";
import type { SroPoBom } from "@/lib/erp-types";

// ---------------------------------------------------------------------------
// Freeze an approved SRO order's cost again from today's bill of materials, so
// a product model chosen or a Bamida price corrected under BOM reaches an order
// approved before it. Only while no manufacturing order has been raised under
// it (recostSroPo says why). bom.edit gated; audited to ops bom_edit_log
// (model_code = ORDER:<number>). Nothing is sent anywhere.
// ---------------------------------------------------------------------------

const Schema = z.object({ poId: z.string().uuid() });

export type RecostSroOrderResult = { success: true; poNumber: string } | { success: false; error: string };

/** What the trail keeps of a frozen cost: enough to see what each line was costed as. */
const costRecord = (po: SroPoBom | null) =>
  po && {
    bamida_total: po.bamida_total,
    sro_total: po.sro_total,
    lines: po.lines.map((l) => ({
      sku: l.sku,
      quantity: l.quantity,
      model_code: l.model_code,
      bom_model_code: l.bom_model_code ?? null,
      has_bom: l.has_bom,
      bamida_man_eur: l.bamida_man_eur,
      bamida_print_eur: l.bamida_print_eur,
    })),
  };

export async function recostSroOrder(input: { poId: string }): Promise<RecostSroOrderResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("bom.edit")) {
    return { success: false, error: "Forbidden: missing bom.edit capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid order" };

  const result = await recostSroPo(parsed.data.poId);
  if (!result.ok) return { success: false, error: result.error };

  const { error } = await createAdminClient()
    .from("bom_edit_log")
    .insert({
      model_code: `ORDER:${result.poNumber}`,
      edited_by: auth.user.id,
      edited_by_label: auth.user.email ?? "Hub user",
      before: costRecord(result.before),
      after: costRecord(result.after),
    });
  if (error) console.error("bom_edit_log insert (re-cost) failed", error.message);

  revalidatePath("/bom");
  return { success: true, poNumber: result.poNumber };
}
