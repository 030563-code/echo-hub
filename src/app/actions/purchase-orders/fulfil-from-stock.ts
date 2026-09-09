"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { createCargoRequestDraft } from "@/lib/cargo-request-store";
import { notifyReadyForShipment } from "@/app/actions/purchase-orders/notify-ready-for-shipment";
import type { CargoLine } from "@/lib/cargo-request";

// SRO chose to fulfil the order from stock they already hold in Kosice.
//
// The other half of the decision that used to be made by a trigger. It raises no
// Bamida order and no supplier document, because there is nothing to make.
//
// Dean, 9 Sep 2026: "shouldn't PO-01176 also be a Ready for shipment status
// once the order is fulfilled from stock, then an email and a shipment request
// to Cargo Partner, same as before, because that is the natural next step."
// He is right, and this is the one branch where the SRO order itself travels:
// on the manufacture branch the Bamida order carries the goods onward, and on
// this branch there is no Bamida order, so nothing was carrying them at all.
//
// So taking barriers off the shelf now does exactly what Bamida pressing
// "Manufacturing finished" does: the order becomes ready_for_shipment, a Cargo
// Partner request is DRAFTED (never sent), and somebody is emailed to go and
// release it. The only difference is which door the truck goes to, which is why
// the draft carries pickup_from EB_SRO rather than the factory in Presov.
//
// EB-SRO has never held a counted stock figure, so the screen behind this
// button is honest and empty: it says there is no counted stock rather than
// showing a zero that looks like a fact. The decision is still real.

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
    .select("id, po_number, master_ref, leg, status, notes, fulfilment_type")
    .eq("id", parsed.data.sro_po_id)
    .maybeSingle<{
      id: string;
      po_number: string | null;
      master_ref: string | null;
      leg: string;
      status: string;
      notes: string | null;
      fulfilment_type: string | null;
    }>();
  if (!sro) return { ok: false, error: "SRO order not found." };
  if (sro.leg !== "EB_GROUP_TO_SRO") {
    return { ok: false, error: "Only an SRO order can be fulfilled from SRO stock." };
  }

  const note = parsed.data.note?.trim();
  const notes = note ? `${sro.notes ? sro.notes + "\n" : ""}Fulfilling from SRO stock: ${note}` : sro.notes;

  // Compare-and-set on 'approved'. A second press, or a press racing the
  // Manufacture button, matches no row and is told what actually happened
  // rather than quietly overwriting it.
  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("purchase_orders")
    .update({ status: "ready_for_shipment", fulfilment_type: "stock", notes })
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
      // Keyed on fulfilment_type, not status: the status moves on to
      // ready_for_shipment the moment either branch is chosen, so it can no
      // longer say WHICH branch was chosen. fulfilment_type still can.
      error:
        sro.fulfilment_type === "manufacture"
          ? "This order is already being manufactured, so it cannot come from stock."
          : sro.fulfilment_type === "stock"
            ? "This order is already being fulfilled from stock."
            : `This order is not ready to be fulfilled (it is ${sro.status}).`,
    };
  }

  // Everything below is AFTER the compare-and-set, and best effort. The
  // decision is already recorded; a webhook that will not answer must never
  // turn a decision somebody made into an error that suggests it did not stick.
  //
  // The readiness date is today, because unlike a manufacturing order there is
  // nothing to wait for: the barriers are on the shelf as this runs.
  const readyAt = new Date().toISOString();
  const { data: lineRows } = await admin
    .from("purchase_order_lines")
    .select("product_name, product_family, quantity")
    .eq("po_id", sro.id);

  const draft = await createCargoRequestDraft({
    poId: sro.id,
    poNumber: sro.po_number,
    finishedAt: readyAt,
    lines: (lineRows as CargoLine[] | null) ?? [],
    // Off our own shelf in Kosice, not out of the factory in Presov.
    pickupFrom: "EB_SRO",
  });

  const told = await notifyReadyForShipment(
    { poId: sro.id, poNumber: sro.po_number, masterRef: sro.master_ref },
    draft,
  );
  if (!told.sent && told.reason === "failed") {
    console.error("fulfilFromSroStock ready notify failed", sro.id);
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${sro.id}`);
  return { ok: true };
}
