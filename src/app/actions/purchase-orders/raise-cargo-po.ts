"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { chainNumber } from "@/lib/po-number";
import type { PurchaseOrderLine } from "@/lib/erp-types";

// Raise the Cargo/transport PO (the shipping order, EBSRO8001-2) as a real child
// of the SRO order (EBGRP8001), a sibling of the Bamida manufacturing PO. This makes the
// cargo-partner order a raised, numbered, trackable PO instead of only a SPOT-ID
// lookup. transport.view-gated (logistics owns cargo); written via service-role
// AFTER the gate. It is NOT an intercompany approval leg, so it is created
// already 'approved' (an authorised logistics booking) and never enters the queue.

const Schema = z.object({ sro_po_id: z.string().uuid("Invalid PO id") });

export type RaiseCargoResult =
  | { ok: true; po_number: string; chain: string }
  | { ok: false; error: string };

/** Postgres unique_violation: the (parent_po_id, leg) index caught a second cargo PO. */
const UNIQUE_VIOLATION = "23505";

interface SroPo {
  id: string;
  po_number: string;
  master_ref: string | null;
  leg: string;
  delivery_address: string | null;
  lines?: PurchaseOrderLine[];
}

export async function raiseCargoPo(input: z.infer<typeof Schema>): Promise<RaiseCargoResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("transport.view")) {
    return { ok: false, error: "Forbidden: missing transport.view capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const supabase = await createServerClient();
  const { data: sro } = await supabase
    .from("purchase_orders")
    .select("id, po_number, master_ref, leg, delivery_address, lines:purchase_order_lines(*)")
    .eq("id", parsed.data.sro_po_id)
    .maybeSingle<SroPo>();
  if (!sro) return { ok: false, error: "SRO order not found." };
  if (sro.leg !== "EB_GROUP_TO_SRO") {
    return { ok: false, error: "The cargo PO can only be raised against an SRO order (EB_GROUP_TO_SRO leg)." };
  }

  const admin = createAdminClient();

  // One cargo PO per SRO order — don't raise a second.
  const { data: dupe } = await admin
    .from("purchase_orders")
    .select("id")
    .eq("parent_po_id", sro.id)
    .eq("leg", "SRO_TO_CARGO")
    .limit(1)
    .maybeSingle();
  if (dupe) return { ok: false, error: "A cargo PO already exists for this SRO order." };

  // Create the SRO_TO_CARGO child. The trigger mints po_number and inherits
  // master_ref from parent_po_id. Under an SRO order numbered EBGRP<n> the
  // number is EBSRO<n>-2. Under any other SRO number (an old PO- chain, a
  // warm-started s.r.o. number such as 1405 or EBG26094) it is a PO- number,
  // with a database warning naming the parent, and the order is still raised.
  // Two presses racing past the check above both reach this insert; the unique
  // index on (parent_po_id, leg) refuses the second.
  const { data: child, error: childErr } = await admin
    .from("purchase_orders")
    .insert({
      parent_po_id: sro.id,
      leg: "SRO_TO_CARGO",
      from_entity: "EB-SRO",
      to_entity: "CARGO-PARTNER",
      status: "approved",
      source: "hub",
      requested_by: auth.user.email ?? "Hub",
      delivery_address: sro.delivery_address,
    })
    .select("id, po_number, master_ref, leg")
    .single();
  if (childErr?.code === UNIQUE_VIOLATION) {
    return { ok: false, error: "A cargo PO already exists for this SRO order." };
  }
  if (childErr || !child) {
    console.error("raiseCargoPo insert failed", childErr?.message);
    return { ok: false, error: "Failed to raise the cargo PO." };
  }

  // Copy the SRO order's lines (qty only — cargo carries no unit price).
  const lines = (sro.lines ?? []).map((l) => ({
    po_id: child.id,
    sku: l.sku,
    product_name: l.product_name,
    product_family: l.product_family,
    quantity: l.quantity,
    hs_code: l.hs_code,
  }));
  if (lines.length) {
    const { error: lErr } = await admin.from("purchase_order_lines").insert(lines);
    if (lErr) console.error("raiseCargoPo lines failed", lErr.message);
  }

  revalidatePath("/purchase-orders");
  revalidatePath("/transport");
  return {
    ok: true,
    po_number: child.po_number,
    chain: chainNumber({ po_number: child.po_number, master_ref: child.master_ref, leg: "SRO_TO_CARGO" }),
  };
}
