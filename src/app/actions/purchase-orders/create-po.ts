"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { deletePageState } from "@/lib/page-state-server";
import { RAISE_PO_KEY } from "@/lib/page-drafts";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { holdsOrganisation } from "@/lib/organisations";
import { catalogueFor, indexCodes, raisingBlockedReason, raisingParty, XERO_CODE_COLUMNS, type ProductXeroCodes } from "@/lib/po-raising";

// ---------------------------------------------------------------------------
// Raise a purchase order in the Hub (the FRONT of the intercompany chain).
//
// A holder of `po.create` raises an order for one of THEIR OWN raising parties.
// WHICH LEG it is comes from src/lib/po-raising.ts and is no longer assumed: a
// depot raises DEPOT_TO_EB_GROUP on Group, Group raises EB_GROUP_TO_SRO on
// s.r.o., and s.r.o. raises SRO_TO_SUPPLIER on the manufacturer. Group and
// s.r.o. buying on their own account is ordinary rather than exceptional; the
// manufacturer's board is full of orders with no depot above them. The row lands `status='requested'`, `source='hub'` — the
// Hub's record of truth — awaiting EB-Group admin approval (see decide-po.ts).
//
// Security (mirrors create-quote.ts): capability is re-checked here, the depot is
// validated against the caller's own `allowed_depots`, SKUs are validated against
// the catalogue server-side (never trust client product names), and the write goes
// through the SESSION client so the "hub: raise PO" RLS policy is the enforcer.
// po_number / master_ref are minted by the po_before_insert DB trigger: EBUSA8001
// for a US depot, EBCAN for Canada, EBFRA for France, EBAUS for Australia.
// ---------------------------------------------------------------------------

const LineSchema = z.object({
  sku: z.string().trim().min(1, "SKU required"),
  quantity: z.number().int().min(1).max(100000),
  hs_code: z.string().trim().max(40).optional(),
  unit_price: z.number().nonnegative().max(1_000_000_000).optional(),
});

const CreatePOSchema = z.object({
  from_entity: z.string().trim().min(1, "Select the raising depot"),
  delivery_address: z.string().trim().min(1, "Select a delivery address").max(2000),
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

  // The raising party decides the leg, the counterparty and the Xero item code
  // column. An unmapped one refuses with a sentence rather than defaulting.
  const party = raisingParty(data.from_entity);
  const blocked = raisingBlockedReason(data.from_entity);
  if (!party || blocked) {
    return { success: false, error: blocked ?? "That party cannot raise purchase orders." };
  }

  // Scope: a raiser may only raise for one of their own parties. Super admins
  // and ALL pass. allowed_depots carries depot codes; Group and s.r.o. are
  // reached by holding the organisation, which the next check is.
  const depots = profile.allowed_depots ?? [];
  const partyOk =
    profile.is_super_admin || depots.includes("ALL") || depots.includes(party.code) || party.leg !== "DEPOT_TO_EB_GROUP";
  if (!partyOk) {
    return { success: false, error: "You are not permitted to raise a PO for this depot" };
  }
  if (!holdsOrganisation(profile.organisations, party.org)) {
    return { success: false, error: "That party belongs to an organisation you do not hold." };
  }

  const supabase = await createServerClient();

  // Validate SKUs against the catalogue + resolve names/families server-side.
  const skus = [...new Set(data.lines.map((l) => l.sku))];
  const [{ data: catalog }, { data: codeRows }] = await Promise.all([
    supabase
      .from("po_product_catalog")
      .select("sku, product_name, product_family, internal_sku")
      .in("sku", skus)
      .eq("active", true),
    supabase
      .from("product_code_master")
      .select(["internal_sku", ...XERO_CODE_COLUMNS].join(", "))
      .eq("is_active", true),
  ]);

  const catMap = new Map((catalog ?? []).map((c) => [c.sku, c]));
  const unknown = skus.filter((s) => !catMap.has(s));
  if (unknown.length) {
    return { success: false, error: `Unknown product code(s): ${unknown.join(", ")}` };
  }

  // 🔴 And that THIS party can actually order them. The form only offers
  // products with a Xero item code for the raising party, but the form is not
  // the enforcer: a line with no code reaches n8n, which drops it into
  // `unmapped_skus` and carries on, so the order would arrive in Xero SHORT A
  // LINE with nobody told. Refuse here instead, naming the products.
  const codesByInternal = indexCodes((codeRows ?? []) as unknown as Partial<ProductXeroCodes>[]);
  const orderable = new Set(
    catalogueFor(party, catalog ?? [], codesByInternal).map((row) => row.item.sku),
  );
  const unmapped = skus.filter((s) => !orderable.has(s));
  if (unmapped.length) {
    return {
      success: false,
      error: `${party.label} has no Xero product code for: ${unmapped.join(", ")}. Those products cannot be ordered by it until a code is set.`,
    };
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
      leg: party.leg,
      from_entity: party.code,
      to_entity: party.to,
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
  // The PO exists, so the form draft behind it is spent. Cleared here as well
  // as in the browser, for the tab that was closed between the two.
  await deletePageState(RAISE_PO_KEY);

  return { success: true, po_number: po.po_number, po_id: po.id };
}
