"use server";

/**
 * Send an approved purchase order leg to Xero again, after the first send failed.
 *
 * Approving a Depot or Group leg posts it to n8n, which creates the Xero purchase order. When that
 * post failed, nothing could send it again: hub_approve_po_leg refuses a second approval, and it
 * should, because approving also raises the next leg and freezes the cost. So this re-posts the
 * SAME payload the approval sent (the approval's approver, the lines, the Xero organisation and
 * item codes, and the document), through the same function, and runs nothing else.
 *
 * 🔴 n8n does not check Xero before it creates. Workflow Fz7xXgifva5n548u posts a new purchase
 * order every run: no lookup by PurchaseOrderNumber, no idempotency key. A run can also fail
 * AFTER Xero made the order (the authorise step, or the write-back of the id), and then the Hub
 * sees a failure while Xero holds a draft or an unlinked copy. So a retry is only ever a decision:
 *   - the approver confirms they looked for the number in Xero and it is not there, and the
 *     number they confirmed must be this order's;
 *   - only a leg whose send has FAILED can be retried, never one that may still be on its way;
 *   - the retry claims the leg first, one conditional update, so of two approvers pressing at
 *     once one sends and the other is told; and the claim is bound to the attempt count the
 *     approver was shown, so a page that has gone stale since cannot send;
 *   - the Xero id is read again after the claim, in case n8n wrote it back meanwhile.
 * Until n8n itself looks the number up before creating, these are the whole defence.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { poChainHeldBy } from "@/lib/po-organisations";
import { externalCallsDisabled, STAGING_SKIP_NOTE } from "@/lib/env";
import {
  XERO_SEND_COLUMNS,
  XERO_SEND_GRACE_MS,
  belongsInXero,
  hasXeroId,
  sendsToXero,
  xeroSendView,
  type XeroSendRecord,
} from "@/lib/po-xero-send";
import { handOffApprovedLeg, type HandoffLeg } from "./xero-handoff";

const Input = z.object({
  poId: z.string().uuid("Invalid PO id"),
  /** The purchase order number the approver says they looked for in Xero and did not find. */
  checkedXeroFor: z.string().trim().max(60),
  /** How many sends the approver's page showed. A different count means the page is stale. */
  attempts: z.number().int().min(0).max(10_000),
});

export type SendToXeroAgainInput = z.infer<typeof Input>;
export type SendToXeroAgainResult = { ok: true; description: string } | { ok: false; error: string };

type LegRow = HandoffLeg & {
  status: string;
  source: "hub" | "n8n";
  approved_at: string | null;
  approved_by: string | null;
  approved_by_uid: string | null;
  xero_po_id: string | null;
};

const LEG_SELECT =
  "id, po_number, master_ref, parent_po_id, reference_po_number, leg, status, source, from_entity, to_entity, delivery_address, approved_at, approved_by, approved_by_uid, xero_po_id, lines:purchase_order_lines(*)";

export async function sendToXeroAgain(input: SendToXeroAgainInput): Promise<SendToXeroAgainResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  // Putting an order on the ledger is the approver's act, as the approval itself is.
  if (!auth.capabilities.has("po.approve")) {
    return { ok: false, error: "Forbidden: missing po.approve capability" };
  }
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { poId, checkedXeroFor, attempts } = parsed.data;

  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false, error: "Purchase order not found." };
  }

  // The staging sandbox never hands anything to n8n, a retry included. Before any read or claim,
  // so staging writes nothing either.
  if (externalCallsDisabled()) return { ok: false, error: STAGING_SKIP_NOTE };

  const supabase = await createServerClient();
  const po = await readLeg(supabase, poId);
  if (!po) return { ok: false, error: "Purchase order not found." };

  const admin = createAdminClient();
  const { data: recordRow } = await admin
    .from("po_xero_sends")
    .select(XERO_SEND_COLUMNS)
    .eq("po_id", poId)
    .maybeSingle<XeroSendRecord>();

  const nowMs = Date.now();
  const refusal = whyNot(po, recordRow ?? null, nowMs);
  if (refusal) return { ok: false, error: refusal };

  if (checkedXeroFor !== po.po_number) {
    return {
      ok: false,
      error: `Look for ${po.po_number} in Xero first, drafts included, and tick the box to say it is not there. n8n does not check before it creates, so sending an order Xero already holds makes a second one.`,
    };
  }
  const current = recordRow?.attempts ?? 0;
  if (attempts !== current) {
    return { ok: false, error: `${po.po_number} has been sent since this page was loaded. Refresh the page and look again before sending.` };
  }

  // --- Claim the leg BEFORE anything leaves ------------------------------------------------
  // Make sure the row exists without touching one that does: a leg approved before the Hub kept
  // this record has none.
  const { error: ensureErr } = await admin
    .from("po_xero_sends")
    .upsert({ po_id: poId }, { onConflict: "po_id", ignoreDuplicates: true });
  if (ensureErr) {
    console.error("sendToXeroAgain: the send row could not be made", ensureErr.message);
    return { ok: false, error: "The send could not be recorded, so nothing was sent." };
  }
  // THE CLAIM. One conditional update: of two requests racing here, one gets the row back and
  // the other gets none. It also refuses when the attempt count moved since the approver looked.
  // A claim older than the grace period belongs to a server that stopped mid-send, and is free.
  const staleBefore = new Date(nowMs - XERO_SEND_GRACE_MS).toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from("po_xero_sends")
    .update({ claimed_at: new Date(nowMs).toISOString() })
    .eq("po_id", poId)
    .eq("attempts", attempts)
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .select("po_id");
  if (claimErr) {
    console.error("sendToXeroAgain: the claim failed", claimErr.message);
    return { ok: false, error: "The send could not be recorded, so nothing was sent." };
  }
  if (!claimed || claimed.length === 0) {
    return {
      ok: false,
      error: `Somebody is sending ${po.po_number} to Xero right now, or has just done so. Refresh the page to see where it stands.`,
    };
  }

  const release = () => admin.from("po_xero_sends").update({ claimed_at: null }).eq("po_id", poId);

  // n8n may have written the id back between the first read and the claim.
  const fresh = await readLeg(supabase, poId);
  if (!fresh || hasXeroId(fresh)) {
    await release();
    return { ok: false, error: `Xero already holds ${po.po_number}, so nothing was sent.` };
  }

  // The approval's approver, as the approval recorded them: this is the same order, authorised
  // by the same person, whoever is pressing now.
  const handoff = await handOffApprovedLeg(
    supabase,
    fresh,
    { label: fresh.approved_by || "Hub approver", uid: fresh.approved_by_uid },
    auth.user.id,
  );

  revalidatePath("/");
  revalidatePath("/purchase-orders");
  revalidatePath("/purchase-orders/approvals");
  revalidatePath(`/purchase-orders/${poId}`);

  if (handoff.sent) {
    return { ok: true, description: `${po.po_number} was sent to Xero again, and n8n accepted it.` };
  }
  if (handoff.reason === "staging") {
    // Checked above, so this cannot happen; the claim still goes back if it ever does.
    await release();
    return { ok: false, error: STAGING_SKIP_NOTE };
  }
  return {
    ok: false,
    error:
      handoff.reason === "timed_out"
        ? `${po.po_number} may not be in Xero yet. ${handoff.error} Its page shows whether the Xero purchase order comes back.`
        : `${po.po_number} is still not in Xero. ${handoff.error}`,
  };
}

async function readLeg(supabase: Awaited<ReturnType<typeof createServerClient>>, poId: string): Promise<LegRow | null> {
  const { data } = await supabase.from("purchase_orders").select(LEG_SELECT).eq("id", poId).maybeSingle<LegRow>();
  return data ?? null;
}

/** Why this leg cannot be sent again right now, or null when it can. */
function whyNot(po: LegRow, record: XeroSendRecord | null, nowMs: number): string | null {
  if (!sendsToXero(po.leg)) {
    return `${po.po_number} is not a Depot or Group order, and only those go to Xero.`;
  }
  if (hasXeroId(po)) return `Xero already holds ${po.po_number}, so nothing was sent.`;
  if (!belongsInXero(po)) return `${po.po_number} is not an approved order, so there is nothing to send.`;
  const view = xeroSendView(po, record, nowMs);
  if (!view) return `${po.po_number} is not an approved order, so there is nothing to send.`;
  if (view.kind === "sandbox") {
    return `${po.po_number} was approved in the staging sandbox, which never sends to Xero, and the Hub does not send sandbox approvals to Xero from here.`;
  }
  if (view.kind === "waiting") {
    return `Not sent again yet. ${view.message} Sending it again now could put a second copy in Xero.`;
  }
  return null;
}
