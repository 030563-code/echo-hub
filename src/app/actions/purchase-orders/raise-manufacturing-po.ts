"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { chainNumber } from "@/lib/po-number";
import type { PurchaseOrderLine } from "@/lib/erp-types";

// SRO chose to MANUFACTURE. Raise the Bamida order.
//
// Until 8 Sep 2026 this row appeared on its own: approving the EB_GROUP_TO_SRO
// leg minted the SRO_TO_SUPPLIER child immediately, which answered the stock or
// manufacture question before anyone was asked it. That auto-mint is gone, so
// the child now exists only because somebody chose to build.
//
// The row it produces is deliberately IDENTICAL to the one the trigger used to
// insert, unit prices included. Nothing downstream (the Bamida PO document, the
// BOM cost snapshot, the lifecycle board) should be able to tell the difference
// between an order raised the old way and one raised by a person.
//
// to_entity stays "SUPPLIER" rather than "BAMIDA": po-pdf-data.ts maps exactly
// that code to the Bamida address block, so renaming it would print a bare code
// where the supplier's address belongs, and would split three existing rows off
// from every new one.
//
// Pressed twice, this must raise ONE order. Two things stop a second: the
// parent leaves 'approved' the moment the first press lands, and the unique
// index on (parent_po_id, leg) refuses the insert outright. The second is the
// one that holds under a genuine race, where both requests read 'approved'
// before either writes.

const Schema = z.object({ sro_po_id: z.string().uuid("Invalid PO id") });

export type RaiseManufacturingResult =
  | { ok: true; po_number: string; chain: string; po_id: string }
  | { ok: false; error: string };

interface SroPo {
  id: string;
  po_number: string;
  master_ref: string | null;
  leg: string;
  status: string;
  delivery_address: string | null;
  notes: string | null;
  lines?: PurchaseOrderLine[];
}

/** Postgres unique_violation: the (parent_po_id, leg) backstop caught a race. */
const UNIQUE_VIOLATION = "23505";

export async function raiseManufacturingPo(
  input: z.infer<typeof Schema>,
): Promise<RaiseManufacturingResult> {
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
    .select("id, po_number, master_ref, leg, status, delivery_address, notes, lines:purchase_order_lines(*)")
    .eq("id", parsed.data.sro_po_id)
    .maybeSingle<SroPo>();
  if (!sro) return { ok: false, error: "SRO order not found." };
  if (sro.leg !== "EB_GROUP_TO_SRO") {
    return { ok: false, error: "A manufacturing order can only be raised against an SRO order." };
  }
  if (sro.status !== "approved") {
    return {
      ok: false,
      error:
        sro.status === "in_manufacturing"
          ? "This order is already being manufactured."
          : sro.status === "fulfilling_from_stock"
            ? "This order is being fulfilled from SRO stock, so there is nothing to manufacture."
            : `This order is not ready to be fulfilled (it is ${sro.status}).`,
    };
  }

  const admin = createAdminClient();

  const { data: dupe } = await admin
    .from("purchase_orders")
    .select("id, po_number")
    .eq("parent_po_id", sro.id)
    .eq("leg", "SRO_TO_SUPPLIER")
    .limit(1)
    .maybeSingle();
  if (dupe) return { ok: false, error: "A manufacturing order already exists for this SRO order." };

  // The trigger mints po_number and inherits master_ref from parent_po_id, so
  // chainNumber renders this as base-1 with no change to po-number.ts.
  const { data: child, error: childErr } = await admin
    .from("purchase_orders")
    .insert({
      parent_po_id: sro.id,
      leg: "SRO_TO_SUPPLIER",
      from_entity: "EB-SRO",
      to_entity: "SUPPLIER",
      status: "approved",
      source: "hub",
      requested_by: auth.user.email ?? "Hub",
      reference_po_number: sro.po_number,
      delivery_address: sro.delivery_address,
      notes: sro.notes,
    })
    .select("id, po_number, master_ref, leg")
    .single();

  if (childErr?.code === UNIQUE_VIOLATION) {
    return { ok: false, error: "A manufacturing order already exists for this SRO order." };
  }
  if (childErr || !child) {
    console.error("raiseManufacturingPo insert failed", childErr?.message);
    return { ok: false, error: "Failed to raise the manufacturing order." };
  }

  // Same columns the trigger copied, unit_price included: this is a supplier
  // order and its prices are what the BOM snapshot and the Bamida document read.
  const lines = (sro.lines ?? []).map((l) => ({
    po_id: child.id,
    sku: l.sku,
    product_name: l.product_name,
    product_family: l.product_family,
    quantity: l.quantity,
    hs_code: l.hs_code,
    unit_price: l.unit_price,
  }));
  if (lines.length) {
    const { error: lErr } = await admin.from("purchase_order_lines").insert(lines);
    if (lErr) console.error("raiseManufacturingPo lines failed", lErr.message);
  }

  // The SRO leg is now committed to building. This also closes the door on the
  // stock branch and on a second press: both require status 'approved'.
  const { error: statusErr } = await admin
    .from("purchase_orders")
    .update({ status: "in_manufacturing", fulfilment_type: "manufacture" })
    .eq("id", sro.id)
    .eq("status", "approved");
  if (statusErr) console.error("raiseManufacturingPo parent status failed", statusErr.message);

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${sro.id}`);
  revalidatePath("/bom");
  return {
    ok: true,
    po_id: child.id,
    po_number: child.po_number,
    chain: chainNumber({ po_number: child.po_number, master_ref: child.master_ref, leg: "SRO_TO_SUPPLIER" }),
  };
}
