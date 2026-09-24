"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { getAuthorizedUser } from "@/lib/authz";
import { poChainHeldBy } from "@/lib/po-organisations";
import { externalCallsDisabled } from "@/lib/env";
import { entityLabel } from "@/lib/depot-constants";
import { snapshotSroPoCost } from "@/lib/bom";
import { sendsToXero, unpricedLines, unpricedRefusal, type UnpricedLine } from "@/lib/po-xero-send";
import { notifySroPoReady } from "./notify-sro";
import { handOffApprovedLeg, recordSandboxApproval } from "./xero-handoff";
import type { PurchaseOrderLine } from "@/lib/erp-types";

// ---------------------------------------------------------------------------
// Three-tier PO approval (Depot → Group → SRO), admin-gated. Each tier is its own
// `requested` leg; approving it:
//   1. marks the leg approved (+ the real approver identity),
//   2. RAISES the next tier's leg as a new `requested` row (so it appears in the
//      approval queue) — Depot→Group→SRO; SRO is terminal,
//   3. fires the n8n webhook for the APPROVED leg, so n8n creates the AUTHORISED PO
//      in THAT tier's Xero account under the Hub's own po_number (EBUSA8001,
//      EBGRP8001; the numbering scheme of 14 Sep 2026) and writes the Xero ids
//      back onto the leg. All Xero work + per-entity product codes live in n8n
//      (the Xero-via-n8n decision); the Hub holds no Xero credentials.
//
// The Hub owns the legs, their numbers and the progression, so the chain is
// testable without n8n and the number never changes after the order is raised.
//
// email-recipients: none (the po-hub-approved webhook creates the Xero PO in
// that tier's account. It sends no mail. Any email raised from this file has
// to resolve its addresses through @/lib/email-recipients.)
// ---------------------------------------------------------------------------

const DecideSchema = z.object({
  poId: z.string().uuid("Invalid PO id"),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
  /**
   * The lines with no unit price the approver saw and agreed to send to Xero at 0. Checked
   * against the order's own lines here, so a stale page or a hand-made request cannot approve a
   * line nobody was shown.
   */
  zeroPriceLineIds: z.array(z.string().uuid()).max(100).optional(),
});

export type DecidePOInput = z.infer<typeof DecideSchema>;

export type DecidePOResult =
  | {
      success: true;
      status: "approved" | "rejected";
      tier: string;
      nextPoNumber?: string;
      /** The SRO leg raises nothing until somebody chooses stock or manufacture. */
      awaitingFulfilment?: boolean;
      warning?: string;
    }
  /** `unpricedLines` is set when the refusal is the unpriced lines, so a screen can ask. */
  | { success: false; error: string; unpricedLines?: UnpricedLine[] };

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
  const { poId, decision, note, zeroPriceLineIds } = parsed.data;
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
  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { success: false, error: "Purchase order not found" };
  }
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

  // ----- UNPRICED LINES ---------------------------------------------------
  // n8n builds each Xero line as `UnitAmount: l.unit_price || 0`, so a line with no price used
  // to reach Xero at 0 with nobody told. A price can only be entered when an order is raised
  // (nothing in the Hub adds one later), and on 24 Sep 2026 every approved Depot and Group leg
  // had none, so refusing outright would strand every order. Instead the approver is shown the
  // lines and confirms them, and the confirmation is checked here against the order's own lines.
  // Only the legs n8n puts in Xero; the manufacturing leg never goes there.
  if (sendsToXero(po.leg)) {
    const unpriced = unpricedLines(po.lines ?? []);
    const confirmed = new Set(zeroPriceLineIds ?? []);
    if (unpriced.some((line) => !confirmed.has(line.id))) {
      return { success: false, error: unpricedRefusal(po.po_number, unpriced), unpricedLines: unpriced };
    }
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
    child_id?: string | null;
    child_po_number?: string | null;
    awaiting_fulfilment?: boolean;
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

  // Hand the APPROVED leg to n8n, which creates its Xero PO in that tier's account and writes
  // the Xero id back. Best effort: the Hub record is already saved. Since 24 Sep 2026 every
  // outcome is recorded on the leg (public.po_xero_sends), a missing webhook counts as a
  // failure rather than an expected quiet, and a failed leg can be sent again from its page.
  if (externalCallsDisabled()) {
    // Staging sandbox: never hand off to n8n/Xero, even if a URL is configured. Staging shares
    // the live database, so the leg is marked, or the live Hub would offer to send it for real.
    if (sendsToXero(po.leg)) await recordSandboxApproval(po.id);
    warning = `Sandbox: ${tier} PO approved and saved in the Hub. The Xero hand-off is disabled in staging.`;
  } else {
    const handoff = await handOffApprovedLeg(supabase, po, { label, uid: user.id }, user.id);
    if (!handoff.sent && handoff.reason !== "staging") {
      warning =
        handoff.reason === "timed_out"
          ? `Approved and saved, but the ${tier} order may not be in Xero yet. ${handoff.error} Its page shows whether the Xero purchase order comes back.`
          : sendsToXero(po.leg)
            ? `Approved and saved, but the ${tier} order is NOT in Xero. ${handoff.error} Open the order to send it to Xero again.`
            : `Approved and saved, but n8n did not take the ${tier} hand-off. ${handoff.error}`;
    }
  }

  // The order has just landed at SRO: tell whoever the Hub names that a decision
  // is waiting on them.
  //
  // THIS FIRES ON THE APPROVAL OF THE SRO LEG, not on the depot approval that
  // creates it. Dean, 9 Sep 2026: the email arrived while the order was still in
  // the Group approval queue. It did, because it used to fire the moment the SRO
  // leg was CREATED, which is one tier too early. A just-created leg is
  // 'requested': it sits under Group → S.R.O on the board, the fulfilment card
  // refuses to render, and the link in the email lands on a page that says
  // nothing is waiting. `awaiting_fulfilment` is the RPC saying this leg is
  // approved and now waiting on the stock-or-manufacture decision, which is
  // exactly the decision the email asks somebody to make.
  //
  // Best effort and AFTER the Hub record is saved, so a mail failure can never
  // undo an approval that happened. Addresses are resolved through the Hub-wide
  // test switch, so during end-to-end testing this reaches nobody else.
  if (result.awaiting_fulfilment === true) {
    // from_entity on this leg is EB-GROUP, because Group are the ones ordering.
    // The depot that started the chain is the parent's.
    let fromDepot = po.from_entity;
    if (po.parent_po_id) {
      const { data: parent } = await supabase
        .from("purchase_orders")
        .select("from_entity")
        .eq("id", po.parent_po_id)
        .maybeSingle<{ from_entity: string | null }>();
      if (parent?.from_entity) fromDepot = parent.from_entity;
    }

    const notified = await notifySroPoReady({
      poId: po.id,
      poNumber: po.po_number,
      masterRef: po.master_ref,
      // The name, not the code. Nobody outside this database knows US-BAL.
      fromDepot: entityLabel(fromDepot),
      approvedBy: label,
      // No SKU: an email says what the product is, not what we call it in here.
      lines: (po.lines ?? []).map((l) => ({
        product_name: l.product_name,
        quantity: l.quantity,
      })),
    });
    // EVERY non-send is reported, not only a failed request. Until 16 Sep 2026
    // this named "failed" alone, so a missing N8N_SRO_NOTIFY_WEBHOOK_URL made
    // the email vanish with the approval looking entirely successful. Dean had
    // to ask whether Juraj had been emailed, which is the question a screen
    // should never leave open.
    if (!notified.sent && notified.reason !== "staging") {
      warning =
        warning ??
        (notified.reason === "not_configured"
          ? "Approved and saved, but SRO were NOT emailed: the Hub has no SRO notification webhook configured. Tell whoever looks after the server."
          : "Approved and saved, but the email telling SRO the order is waiting did not send.");
    }
  }

  revalidatePath("/purchase-orders");
  revalidatePath("/purchase-orders/approvals");
  return {
    success: true,
    status: "approved",
    tier,
    nextPoNumber,
    awaitingFulfilment: result.awaiting_fulfilment === true,
    warning,
  };
}
