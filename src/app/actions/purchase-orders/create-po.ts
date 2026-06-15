"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Raise a purchase order in the Hub (the FRONT of the intercompany chain).
//
// A branch/depot user with `po.create` raises a DEPOT_TO_EB_GROUP root PO for one
// of THEIR OWN depots. The row lands `status='requested'`, `source='hub'` — the
// Hub's record of truth — awaiting EB-Group admin approval (see decide-po.ts).
//
// Security (mirrors create-quote.ts): capability is re-checked here, the depot is
// validated against the caller's own `allowed_depots`, SKUs are validated against
// the catalogue server-side (never trust client product names), and the write goes
// through the SESSION client so the "hub: raise PO" RLS policy is the enforcer.
// po_number / master_ref are minted by the existing po_before_insert DB trigger.
// ---------------------------------------------------------------------------

const LineSchema = z.object({
  sku: z.string().trim().min(1, "SKU required"),
  quantity: z.number().int().min(1).max(100000),
  hs_code: z.string().trim().max(40).optional(),
  unit_price: z.number().nonnegative().max(1_000_000_000).optional(),
});

const CreatePOSchema = z.object({
  from_entity: z.string().trim().min(1, "Select the raising depot"),
  delivery_address: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(LineSchema).min(1, "Add at least one line item").max(100),
});

export type CreatePOInput = z.infer<typeof CreatePOSchema>;

export type CreatePOResult =
  | { success: true; po_number: string; po_id: string }
  | { success: false; error: string };

export async function createPurchaseOrder(input: CreatePOInput): Promise<CreatePOResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { success: false, error: "Forbidden: missing po.create capability" };
  }

  const parsed = CreatePOSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const { profile, user } = auth;

  // Depot scope — a raiser may only raise for one of their own depots. Super
  // admins and the `ALL` sentinel bypass. (The "hub: raise PO" RLS policy enforces
  // the same check at the DB layer — defence in depth.)
  const depots = profile.allowed_depots ?? [];
  const depotOk = profile.is_super_admin || depots.includes("ALL") || depots.includes(data.from_entity);
  if (!depotOk) {
    return { success: false, error: "You are not permitted to raise a PO for this depot" };
  }

  const supabase = await createServerClient();

  // Validate SKUs against the catalogue + resolve names/families server-side.
  const skus = [...new Set(data.lines.map((l) => l.sku))];
  const { data: catalog } = await supabase
    .from("po_product_catalog")
    .select("sku, product_name, product_family")
    .in("sku", skus)
    .eq("active", true);

  const catMap = new Map((catalog ?? []).map((c) => [c.sku, c]));
  const unknown = skus.filter((s) => !catMap.has(s));
  if (unknown.length) {
    return { success: false, error: `Unknown product code(s): ${unknown.join(", ")}` };
  }

  // Human-readable label for the free-text requested_by column (n8n writes labels
  // here too); the real identity trail is requested_by_uid.
  const { data: prof } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  const label = prof?.display_name || user.email || "Hub user";

  // Insert the parent (root) PO. Omit po_number/master_ref — the trigger fills them.
  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .insert({
      leg: "DEPOT_TO_EB_GROUP",
      from_entity: data.from_entity,
      to_entity: "EB-GROUP",
      status: "requested",
      source: "hub",
      requested_by_uid: user.id,
      requested_by: label,
      delivery_address: data.delivery_address || null,
      notes: data.notes || null,
    })
    .select("id, po_number")
    .single();

  if (poErr || !po) {
    console.error("createPurchaseOrder: parent insert failed", poErr?.message);
    return { success: false, error: "Failed to raise the purchase order. Please try again." };
  }

  // Insert the line items (the "hub: add PO lines" policy ties them to this PO).
  const lineRows = data.lines.map((l) => {
    const cat = catMap.get(l.sku)!;
    return {
      po_id: po.id,
      sku: l.sku,
      product_name: cat.product_name,
      product_family: cat.product_family,
      quantity: l.quantity,
      hs_code: l.hs_code || null,
      unit_price: l.unit_price ?? null,
    };
  });

  const { error: lineErr } = await supabase.from("purchase_order_lines").insert(lineRows);
  if (lineErr) {
    console.error("createPurchaseOrder: line insert failed", lineErr.message);
    // Clean up the orphan parent (authenticated has no DELETE policy → service role).
    try {
      await createAdminClient().from("purchase_orders").delete().eq("id", po.id);
    } catch {
      /* best-effort cleanup */
    }
    return { success: false, error: "Failed to save the line items. Please try again." };
  }

  revalidatePath("/purchase-orders");
  revalidatePath("/purchase-orders/approvals");
  return { success: true, po_number: po.po_number, po_id: po.id };
}
