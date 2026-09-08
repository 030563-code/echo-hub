"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";

// SRO chose to fulfil the order from stock they already hold in Kosice.
//
// The other half of the decision that used to be made by a trigger. This one
// raises NOTHING: no Bamida order, no supplier document, no email. It records
// that the barriers are coming off the shelf, and the order moves on to
// transport from there.
//
// EB-SRO has never held a counted stock figure, so today this branch is honest
// and empty: the screen says there is no counted stock rather than showing a
// zero that looks like a fact. Recording the decision is still worth doing,
// because it is the difference between an order nobody has touched and one
// somebody has answered.

const Schema = z.object({
  sro_po_id: z.string().uuid("Invalid PO id"),
  note: z.string().trim().max(500).optional(),
});

export type FulfilFromStockResult = { ok: true } | { ok: false; error: string };

export async function fulfilFromSroStock(
  input: z.infer<typeof Schema>,
): Promise<FulfilFromStockResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { ok: false, error: "Forbidden: missing po.create capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const supabase = await createServerClient();
  const { data: sro } = await supabase
    .from("purchase_orders")
    .select("id, leg, status, notes")
    .eq("id", parsed.data.sro_po_id)
    .maybeSingle<{ id: string; leg: string; status: string; notes: string | null }>();
  if (!sro) return { ok: false, error: "SRO order not found." };
  if (sro.leg !== "EB_GROUP_TO_SRO") {
    return { ok: false, error: "Only an SRO order can be fulfilled from SRO stock." };
  }

  const note = parsed.data.note?.trim();
  const notes = note ? `${sro.notes ? sro.notes + "\n" : ""}Fulfilling from SRO stock: ${note}` : sro.notes;

  // Compare-and-set on 'approved'. A second press, or a press racing the
  // Manufacture button, matches no row and is told what actually happened
  // rather than quietly overwriting it.
  const { data: updated, error } = await createAdminClient()
    .from("purchase_orders")
    .update({ status: "fulfilling_from_stock", fulfilment_type: "stock", notes })
    .eq("id", sro.id)
    .eq("status", "approved")
    .select("id");
  if (error) {
    console.error("fulfilFromSroStock failed", error.message);
    return { ok: false, error: "Failed to record the decision." };
  }
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error:
        sro.status === "in_manufacturing"
          ? "This order is already being manufactured, so it cannot come from stock."
          : sro.status === "fulfilling_from_stock"
            ? "This order is already being fulfilled from stock."
            : `This order is not ready to be fulfilled (it is ${sro.status}).`,
    };
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${sro.id}`);
  return { ok: true };
}
