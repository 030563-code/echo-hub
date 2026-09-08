"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { getAuthorizedUser } from "@/lib/authz";
import { externalCallsDisabled } from "@/lib/env";
import { snapshotSroPoCost } from "@/lib/bom";
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
//
// email-recipients: none (the po-hub-approved webhook creates the Xero PO in
// that tier's account. It sends no mail. Any email raised from this file has
// to resolve its addresses through @/lib/email-recipients.)
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
  parent_po_id: string | null;
  reference_po_number: string | null;
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
      "id, po_number, master_ref, parent_po_id, reference_po_number, leg, status, source, from_entity, to_entity, delivery_address, notes, lines:purchase_order_lines(*)"
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
    // .select() so a stale/concurrent reject (RLS matches 0 rows once the leg is
    // no longer 'requested') is detected instead of reported as success.
    const { data: rejected, error } = await supabase
      .from("purchase_orders")
      .update({
        status: "rejected",
        approved_by_uid: user.id,
        approved_by: label,
        approved_at: nowIso,
        notes: note ? `${po.notes ? po.notes + "\n" : ""}Rejected (${tier}): ${note}` : po.notes,
      })
      .eq("id", poId)
      .select("id");
    if (error) {
      console.error("decidePurchaseOrder reject failed", error.message);
      return { success: false, error: "Failed to reject the purchase order." };
    }
    if (!rejected || rejected.length === 0) {
      return { success: false, error: "This PO has already been decided." };
    }
    revalidatePath("/purchase-orders");
    revalidatePath("/purchase-orders/approvals");
    return { success: true, status: "rejected", tier };
  }

  // ----- APPROVE (atomic) -------------------------------------------------
  // One RPC does it all under a row lock: guard status='requested' → approve →
  // raise the next leg with reference_po_number = THIS leg's po_number → copy the
  // lines. This replaces three separate writes that could half-fail and strand an
  // approved leg with no successor, is concurrency-safe (a racing/stale approver
  // gets ok=false, not a silent duplicate PO + double Xero fire), and is what
  // finally carries the reference through the chain Hub-side (so n8n receives it
  // in the webhook and never needs its fragile parent-lookup).
  const { data: rpcRes, error: rpcErr } = await supabase.rpc("hub_approve_po_leg", {
    p_po_id: poId,
    p_label: label,
    p_uid: user.id,
  });
  if (rpcErr) {
    console.error("decidePurchaseOrder approve RPC failed", rpcErr.message);
    return { success: false, error: "Failed to approve the purchase order." };
  }
  const result = (rpcRes ?? {}) as {
    ok?: boolean;
    reason?: string;
    next_leg?: string | null;
    child_po_number?: string | null;
  };
  if (!result.ok) {
    return {
      success: false,
      error:
        result.reason === "not_found"
          ? "Purchase order not found."
          : "This PO has already been decided (it is no longer awaiting approval).",
    };
  }

  // Freeze the SRO/BOM cost at approval — best-effort, post-commit.
  if (po.leg === "EB_GROUP_TO_SRO") {
    await snapshotSroPoCost(po.id);
  }

  let warning: string | undefined;
  const nextPoNumber = result.child_po_number ?? undefined;

  // Fire n8n for the APPROVED leg → create its Xero PO in that tier's account and
  // write the real Xero PO# back. Best-effort (the Hub record is already saved).
  const webhookUrl = process.env.N8N_PO_APPROVED_WEBHOOK_URL;
  if (externalCallsDisabled()) {
    // Staging sandbox: never hand off to n8n/Xero, even if a URL is configured.
    warning = warning ?? `Sandbox: ${tier} PO approved and saved in the Hub — the Xero hand-off is disabled in staging.`;
  } else if (webhookUrl) {
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
          po_number: po.po_number,
          master_ref: po.master_ref,
          reference_po_number: po.reference_po_number,
          leg: po.leg,
          tier,
          from_entity: po.from_entity,
          to_entity: po.to_entity,
          parent_po_id: po.parent_po_id,
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
