"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import type { PurchaseOrderLine } from "@/lib/erp-types";

// ---------------------------------------------------------------------------
// Three-tier PO approval (Depot → Group → SRO), admin-gated. Each tier is its own
// `requested` leg; approving it:
//   1. marks the leg approved (+ the real approver identity),
//   2. RAISES the next tier's leg as a new `requested` row (so it appears in the
//      approval queue) — Depot→Group→SRO; SRO is terminal,
//   3. fires the n8n webhook for the APPROVED leg, so n8n creates the AUTHORISED PO
//      in THAT tier's Xero account and writes the real Xero PO# back onto the leg
//      (the depot Xero# becomes the master; n8n also sets reference_po_number to the
//      parent leg's number). All Xero work + per-entity product codes live in n8n
//      (the Xero-via-n8n decision); the Hub holds no Xero credentials.
//
// The Hub owns the legs + progression so the chain is testable without n8n; the
// real Xero numbers replace the Hub placeholders once n8n runs.
// ---------------------------------------------------------------------------

const DecideSchema = z.object({
  poId: z.string().uuid("Invalid PO id"),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});

export type DecidePOInput = z.infer<typeof DecideSchema>;

export type DecidePOResult =
  | { success: true; status: "approved" | "rejected"; tier: string; nextPoNumber?: string; warning?: string }
  | { success: false; error: string };

type Leg = "DEPOT_TO_EB_GROUP" | "EB_GROUP_TO_SRO" | "SRO_TO_SUPPLIER";

// What each tier raises next, and the from/to entities of that next leg.
const NEXT_LEG: Record<Leg, { leg: Leg; from: string; to: string } | null> = {
  DEPOT_TO_EB_GROUP: { leg: "EB_GROUP_TO_SRO", from: "EB-GROUP", to: "EB-SRO" },
  EB_GROUP_TO_SRO: { leg: "SRO_TO_SUPPLIER", from: "EB-SRO", to: "SUPPLIER" },
  SRO_TO_SUPPLIER: null,
};

const TIER_LABEL: Record<Leg, string> = {
  DEPOT_TO_EB_GROUP: "Depot",
  EB_GROUP_TO_SRO: "Group",
  SRO_TO_SUPPLIER: "SRO",
};

interface POForDecision {
  id: string;
  po_number: string;
  master_ref: string | null;
  leg: Leg;
  status: string;
  source: string;
  from_entity: string;
  to_entity: string;
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

  const { data: po } = await supabase
    .from("purchase_orders")
    .select(
      "id, po_number, master_ref, leg, status, source, from_entity, to_entity, delivery_address, notes, lines:purchase_order_lines(*)"
    )
    .eq("id", poId)
    .maybeSingle<POForDecision>();

  if (!po) return { success: false, error: "Purchase order not found" };
  if (po.source !== "hub" || po.status !== "requested" || !(po.leg in NEXT_LEG)) {
    return { success: false, error: "This PO is not awaiting Hub approval." };
  }

  const tier = TIER_LABEL[po.leg];

  const { data: prof } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  const label = prof?.display_name || user.email || "Hub approver";
  const nowIso = new Date().toISOString();

  // ----- REJECT (terminal for this leg) -----------------------------------
  if (decision === "reject") {
    const { error } = await supabase
      .from("purchase_orders")
      .update({
        status: "rejected",
        approved_by_uid: user.id,
        approved_by: label,
        approved_at: nowIso,
        notes: note ? `${po.notes ? po.notes + "\n" : ""}Rejected (${tier}): ${note}` : po.notes,
      })
      .eq("id", poId);
    if (error) {
      console.error("decidePurchaseOrder reject failed", error.message);
      return { success: false, error: "Failed to reject the purchase order." };
    }
    revalidatePath("/purchase-orders");
    revalidatePath("/purchase-orders/approvals");
    return { success: true, status: "rejected", tier };
  }

  // ----- APPROVE ----------------------------------------------------------
  const { error: upErr } = await supabase
    .from("purchase_orders")
    .update({ status: "approved", approved_by_uid: user.id, approved_by: label, approved_at: nowIso })
    .eq("id", poId);

  if (upErr) {
    console.error("decidePurchaseOrder approve failed", upErr.message);
    return { success: false, error: "Failed to approve the purchase order." };
  }

  const admin = createAdminClient();
  let warning: string | undefined;
  let nextPoNumber: string | undefined;

  // Raise the next tier's leg (so it enters the queue). Intercompany row via
  // service role; the trigger mints the placeholder po_number + inherits master_ref.
  const next = NEXT_LEG[po.leg];
  if (next) {
    const { data: child, error: childErr } = await admin
      .from("purchase_orders")
      .insert({
        parent_po_id: po.id,
        leg: next.leg,
        from_entity: next.from,
        to_entity: next.to,
        status: "requested",
        source: "hub",
        requested_by: label,
        delivery_address: po.delivery_address,
        notes: po.notes,
      })
      .select("id, po_number")
      .single();

    if (childErr || !child) {
      console.error("decidePurchaseOrder next-leg insert failed", childErr?.message);
      warning = `Approved, but the next tier (${next.leg}) could not be raised — retry or escalate.`;
    } else {
      nextPoNumber = child.po_number;
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
        if (clErr) console.error("decidePurchaseOrder next-leg lines failed", clErr.message);
      }
    }
  }

  // Fire n8n for the APPROVED leg → create its Xero PO in that tier's account and
  // write the real Xero PO# back. Best-effort (the Hub record is already saved).
  const webhookUrl = process.env.N8N_PO_APPROVED_WEBHOOK_URL;
  if (webhookUrl) {
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
          po_id: po.id,
          leg: po.leg,
          tier,
          from_entity: po.from_entity,
          to_entity: po.to_entity,
          parent_po_id: null,
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
        warning = warning ?? `Approved + saved, but the ${tier} Xero hand-off (n8n) did not confirm.`;
      }
    } catch {
      warning = warning ?? `Approved + saved, but the ${tier} Xero hand-off (n8n) could not be reached.`;
    }
  }
  // No webhook configured yet = expected (n8n not wired); not a warning.

  revalidatePath("/purchase-orders");
  revalidatePath("/purchase-orders/approvals");
  return { success: true, status: "approved", tier, nextPoNumber, warning };
}
