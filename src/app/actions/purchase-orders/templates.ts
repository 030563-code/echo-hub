"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { getAuthorizedUser } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Recurring-order templates — save the raise form's config (depot + address +
// notes + lines) and reload it later to pre-fill. po.create gated; RLS keeps
// templates behind the buyer gate (the lines jsonb carries unit_price).
// ---------------------------------------------------------------------------

const TemplateLineSchema = z.object({
  sku: z.string().trim().min(1),
  quantity: z.number().int().positive().max(10_000_000),
  hs_code: z.string().trim().max(40).optional(),
  unit_price: z.number().nonnegative().max(1_000_000_000).optional(),
});

const SaveTemplateSchema = z.object({
  name: z.string().trim().min(1, "Template name required").max(120),
  from_entity: z.string().trim().max(60).optional(),
  delivery_address: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(TemplateLineSchema).min(1, "Add at least one line").max(100),
});

export type SaveTemplateInput = z.infer<typeof SaveTemplateSchema>;
export type SaveTemplateResult = { success: true; id: string } | { success: false; error: string };

export async function saveTemplate(input: SaveTemplateInput): Promise<SaveTemplateResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { success: false, error: "Forbidden: missing po.create capability" };
  }
  const parsed = SaveTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const t = parsed.data;
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("po_templates")
    .insert({
      name: t.name,
      from_entity: t.from_entity || null,
      delivery_address: t.delivery_address || null,
      notes: t.notes || null,
      lines: t.lines,
      created_by_uid: auth.user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("saveTemplate failed", error?.message);
    return { success: false, error: "Failed to save the template." };
  }
  revalidatePath("/purchase-orders/create");
  return { success: true, id: data.id };
}

export async function deleteTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) return { success: false, error: "Forbidden" };
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: "Invalid id" };
  const supabase = await createServerClient();
  // RLS restricts DELETE to the creator (or super-admin).
  const { error } = await supabase.from("po_templates").delete().eq("id", id);
  if (error) {
    console.error("deleteTemplate failed", error.message);
    return { success: false, error: "Failed to delete the template." };
  }
  revalidatePath("/purchase-orders/create");
  return { success: true };
}
