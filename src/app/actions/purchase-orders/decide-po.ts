"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import type { PurchaseOrderLine } from "@/lib/erp-types";

// ---------------------------------------------------------------------------
// EB-Group approval decision on a Hub-raised PO (admin-gated).
//
// `po.approve` flips a Hub-raised, still-`requested` DEPOT_TO_EB_GROUP row to
// approved or rejected. On APPROVE the Hub:
//   1. marks the parent approved (+ the real approver identity in approved_by_uid),
//   2. RAISES + APPROVES the EB_GROUP_TO_SRO leg as a new `approved` child row (the
//      EB Group → SRO purchase order, stamped with the same approver) — via the
//      service-role client (an intercompany write, gated above by po.approve;
//      mirrors the admin.ts privileged-write pattern). This row is the Hub's record
//      of the PO raised to SRO and exists WITHOUT any n8n involvement.
//   3. hands off the CREDENTIALED side-effects to n8n (create the EB-Group Xero PO,
//      email SRO, post the Slack notice) — per the Xero-via-n8n decision, so no Xero
//      or Slack credentials ever live in the (public) Hub repo.
//
// The parent update goes through the SESSION client so the "hub: approve PO" RLS
// policy is the enforcer (it pins requested→approved/rejected on hub rows only).
// ---------------------------------------------------------------------------

const DecideSchema = z.object({
  poId: z.string().uuid("Invalid PO id"),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});

export type DecidePOInput = z.infer<typeof DecideSchema>;

export type DecidePOResult =
  | { success: true; status: "approved" | "rejected"; warning?: string; childPoNumber?: string }
  | { success: false; error: string };

interface POForDecision {
  id: string;
  po_number: string;
  master_ref: string | null;
  leg: string;
  status: string;
  source: string;
  from_entity: string;
  delivery_address: string | null;
  notes: string | null;
  lines?: PurchaseOrderLine[];
}

export async function decidePurchaseOrder(input: DecidePOInput): Promise<DecidePOResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.approve")) {
    return { success: false, error: "Forbidden: missing po.approve capability" };
  }

  const parsed = DecideSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { poId, decision, note } = parsed.data;
  const { user } = auth;

  const supabase = await createServerClient();

  // Load the PO + lines (read-all policy) and assert it is genuinely awaiting Hub
  // approval — an explicit state/IDOR guard before any side-effect.
  const { data: po } = await supabase
    .from("purchase_orders")
    .select(
      "id, po_number, master_ref, leg, status, source, from_entity, delivery_address, notes, lines:purchase_order_lines(*)"
    )
    .eq("id", poId)
    .maybeSingle<POForDecision>();

  if (!po) return { success: false, error: "Purchase order not found" };
  if (po.source !== "hub" || po.leg !== "DEPOT_TO_EB_GROUP" || po.status !== "requested") {
    return { success: false, error: "This PO is not awaiting Hub approval." };
  }

  const { data: prof } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  const label = prof?.display_name || user.email || "Hub approver";
  const nowIso = new Date().toISOString();

  // ----- REJECT -----------------------------------------------------------
  if (decision === "reject") {
    const { error } = await supabase
      .from("purchase_orders")
      .update({
        status: "rejected",
        approved_by_uid: user.id,
        approved_by: label,
        approved_at: nowIso,
        notes: note ? `${po.notes ? po.notes + "\n" : ""}Rejected: ${note}` : po.notes,
      })
      .eq("id", poId);

    if (error) {
      console.error("decidePurchaseOrder reject failed", error.message);
      return { success: false, error: "Failed to reject the purchase order." };
    }
    revalidatePath("/purchase-orders");
    revalidatePath("/purchase-orders/approvals");
    return { success: true, status: "rejected" };
  }

  // ----- APPROVE ----------------------------------------------------------
  const { error: upErr } = await supabase
    .from("purchase_orders")
    .update({
      status: "approved",
      approved_by_uid: user.id,
      approved_by: label,
      approved_at: nowIso,
    })
    .eq("id", poId);

  if (upErr) {
    console.error("decidePurchaseOrder approve failed", upErr.message);
    return { success: false, error: "Failed to approve the purchase order." };
  }

  // Raise + approve the EB_GROUP_TO_SRO leg — the EB Group → SRO purchase order,
  // created already-`approved` and stamped with the same approver (EB Group has
  // approved and raised it to SRO). Intercompany write via service role; the
  // trigger mints the child po_number + inherits master_ref.
  const admin = createAdminClient();
  let warning: string | undefined;

  const { data: child, error: childErr } = await admin
    .from("purchase_orders")
    .insert({
      parent_po_id: po.id,
      leg: "EB_GROUP_TO_SRO",
      from_entity: "EB-GROUP",
      to_entity: "EB-SRO",
      status: "approved",
      source: "hub",
      requested_by: label,
      approved_by: label,
      approved_by_uid: user.id,
      approved_at: nowIso,
      delivery_address: po.delivery_address,
      notes: po.notes,
    })
    .select("id, po_number")
    .single();

  if (childErr || !child) {
    console.error("decidePurchaseOrder child insert failed", childErr?.message);
    warning = "Approved, but the SRO leg could not be created — please retry or escalate.";
  } else {
    const childLines = (po.lines ?? []).map((l) => ({
      po_id: child.id,
      sku: l.sku,
      product_name: l.product_name,
      product_family: l.product_family,
      quantity: l.quantity,
      hs_code: l.hs_code,
      unit_price: l.unit_price,
    }));
    if (childLines.length) {
      const { error: clErr } = await admin.from("purchase_order_lines").insert(childLines);
      if (clErr) console.error("decidePurchaseOrder child lines failed", clErr.message);
    }
  }

  // Hand off the credentialed work to n8n (EB-Group Xero PO + email SRO + Slack).
  // Best-effort: the Hub record of truth is already saved; a webhook miss is a
  // warning, not a failure.
  const webhookUrl = process.env.N8N_PO_APPROVED_WEBHOOK_URL;
  if (webhookUrl && child) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.N8N_PO_APPROVED_WEBHOOK_SECRET
            ? { "x-hub-secret": process.env.N8N_PO_APPROVED_WEBHOOK_SECRET }
            : {}),
        },
        body: JSON.stringify({
          parent_po_id: po.id,
          parent_po_number: po.po_number,
          master_ref: po.master_ref,
          child_po_id: child.id,
          child_po_number: child.po_number,
          from_entity: po.from_entity,
          to_entity: "EB-SRO",
          delivery_address: po.delivery_address,
          approved_by: label,
          approved_by_uid: user.id,
          lines: (po.lines ?? []).map((l) => ({
            sku: l.sku,
            product_name: l.product_name,
            quantity: l.quantity,
            hs_code: l.hs_code,
            unit_price: l.unit_price,
          })),
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        warning = warning ?? "Approved + saved, but the Xero/SRO hand-off (n8n) did not confirm.";
      }
    } catch {
      warning = warning ?? "Approved + saved, but the Xero/SRO hand-off (n8n) could not be reached.";
    }
  }
  // If the webhook isn't configured yet, that's expected (n8n not wired) — NOT a
  // warning. The parent approval + the raised+approved SRO leg are saved either way;
  // only the Xero PO / SRO email / Slack side-effects wait on n8n.

  revalidatePath("/purchase-orders");
  revalidatePath("/purchase-orders/approvals");
  return { success: true, status: "approved", warning, childPoNumber: child?.po_number };
}
