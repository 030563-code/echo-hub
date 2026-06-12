"use server";

import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { hasCapability } from "@/lib/authz";

const UpdateStockSchema = z.object({
  id: z.string().uuid("Invalid record ID"),
  quantity_on_hand: z.number().int().min(0).max(999999),
});

export async function updateWarehouseStock(
  id: string,
  quantity_on_hand: number
): Promise<{ success: true } | { error: string }> {
  // Stock override is a privileged write (it drives MRP red/green) — require
  // stock.edit. Closes the donor's authenticated-IDOR (any user rewriting any row).
  if (!(await hasCapability("stock.edit"))) {
    return { error: "Forbidden: missing stock.edit capability" };
  }
  const parsed = UpdateStockSchema.safeParse({ id, quantity_on_hand });
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { error } = await supabase
    .from("warehouse_stock_levels")
    .update({
      quantity_on_hand: parsed.data.quantity_on_hand,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id);

  if (error) return { error: "Failed to update stock" };
  return { success: true };
}
