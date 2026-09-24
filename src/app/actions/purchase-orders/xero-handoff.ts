import "server-only";

/**
 * Hand one approved purchase order leg to n8n, which creates it in Xero, and record what happened.
 *
 * Not a 'use server' file. Only the action modules are; every export of one is a callable
 * endpoint, and posting to the webhook that creates Xero purchase orders has no business being
 * one. Two actions call this: decide-po.ts right after the approval commits, and
 * send-to-xero-again.ts when that first post failed. One function, so a retry sends exactly what
 * the approval sent, document included.
 *
 * n8n workflow Fz7xXgifva5n548u answers only when its run is over (the webhook responds with its
 * last node), so a refusal, a missing webhook, no answer at all and a run that failed inside all
 * come back here as a failure, and every one of them is written to public.po_xero_sends: when,
 * why, and how many times the leg has been posted. A run that takes longer than the timeout may
 * still finish, so that case is recorded as timed_out rather than failed, and the screens wait
 * before they call it failed.
 *
 * Best effort by construction: the approval is already committed when this runs, so nothing
 * here throws. A failure is returned and recorded, never raised.
 */

// email-recipients: none (the po-hub-approved webhook creates the Xero purchase order in that
// tier's account. It sends no mail.)

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { externalCallsDisabled } from "@/lib/env";
import { renderApprovalAttachment } from "@/lib/xero/attach-po-pdf";
import { DEPOT_MAPPING_COLUMNS, raisingParty, xeroItemCodeFor, type DepotProduct } from "@/lib/po-raising";
import type { PurchaseOrderLine } from "@/lib/erp-types";

/** How long the Hub waits for n8n. A clean run takes seconds; Xero is called four times in it. */
export const XERO_SEND_TIMEOUT_MS = 25_000;

type Leg = "DEPOT_TO_EB_GROUP" | "EB_GROUP_TO_SRO" | "SRO_TO_SUPPLIER";

const TIER_LABEL: Record<Leg, string> = {
  DEPOT_TO_EB_GROUP: "Depot",
  EB_GROUP_TO_SRO: "Group",
  SRO_TO_SUPPLIER: "SRO",
};

/** The leg as both callers read it. */
export interface HandoffLeg {
  id: string;
  po_number: string;
  master_ref: string | null;
  parent_po_id: string | null;
  reference_po_number: string | null;
  leg: Leg;
  from_entity: string;
  to_entity: string;
  delivery_address: string | null;
  lines?: PurchaseOrderLine[];
}

/** Who approved the leg, exactly as the approval recorded it. A retry sends the same person. */
export interface Approver {
  label: string;
  uid: string | null;
}

export type HandoffResult =
  | { sent: true }
  /** Nothing was posted, by design: the staging sandbox never hands anything to n8n. */
  | { sent: false; reason: "staging" }
  | { sent: false; reason: "failed" | "timed_out"; error: string };

/**
 * Post the leg to n8n and write down what came back.
 *
 * `actorUid` is whoever pressed: the approver on an approval, the person retrying on a retry.
 * The payload's approver is always the approval's, because that is who authorised the order.
 */
export async function handOffApprovedLeg(
  supabase: SupabaseClient,
  po: HandoffLeg,
  approver: Approver,
  actorUid: string,
): Promise<HandoffResult> {
  // Staging sandbox: never hand off to n8n or Xero, even if a URL is configured. Nothing was
  // attempted, so nothing is recorded as an attempt.
  if (externalCallsDisabled()) return { sent: false, reason: "staging" };

  const result = await post(supabase, po, approver);
  await recordAttempt(po.id, actorUid, result);
  return result;
}

/**
 * Mark a leg approved in the staging sandbox. Staging shares the live database, so without this
 * the live Hub would see an approved leg with no Xero id and offer to send a sandbox order to
 * Xero for real.
 */
export async function recordSandboxApproval(poId: string): Promise<void> {
  try {
    const { error } = await createAdminClient()
      .from("po_xero_sends")
      .upsert({ po_id: poId, sandbox_at: new Date().toISOString() }, { onConflict: "po_id" });
    if (error) console.error("recordSandboxApproval failed", error.message);
  } catch (error) {
    console.error("recordSandboxApproval failed", error);
  }
}

async function post(supabase: SupabaseClient, po: HandoffLeg, approver: Approver): Promise<HandoffResult> {
  const webhookUrl = String(process.env.N8N_PO_APPROVED_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) {
    return {
      sent: false,
      reason: "failed",
      error: "The server has no Xero hand-off set up: N8N_PO_APPROVED_WEBHOOK_URL is empty.",
    };
  }

  let body: string;
  try {
    // The purchase order document travels WITH the approval, so the same n8n run that creates
    // the Xero purchase order attaches it the moment the id comes back. Dean, 16 Sep 2026: "The
    // attach pdf to Xero should happen after the PO is created in the same execution not
    // seperate workflows." renderApprovalAttachment returns null rather than throwing, so a
    // document that will not render costs us the PDF and never the order.
    const attachment = await renderApprovalAttachment(po.id);

    // 🔴 THE HUB DECIDES THE XERO ORGANISATION AND THE ITEM CODES, not n8n.
    //
    // n8n Fz7xXgifva5n548u chose the item code column with `let codeCol = "code_usa_balt"` and
    // three ifs, and the tenant with `from_entity === 'CA-HAM' ? Canada : USA`. EU-FR already had
    // a number series, so the first French order would have been created in the UNITED STATES
    // organisation carrying US Baltimore codes, silently. Rather than sync a fourth copy of the
    // map, the payload carries the answers and n8n's own lookup is a fallback nothing reaches.
    //
    // The party is read from from_entity, which is a depot on the depot leg, EB-GROUP on the
    // Group leg and EB-SRO on the manufacturing leg. All three are in the registry with their
    // own rows of product_depot_mapping.
    const party = raisingParty(po.from_entity);
    const [{ data: tenantRow }, { data: mapping }] = await Promise.all([
      supabase.from("entities").select("xero_tenant_id").eq("code", party?.org ?? "").maybeSingle(),
      // The party's own rows of product_depot_mapping: the code ITS Xero organisation knows the
      // line under. Dean, 22 Sep 2026.
      supabase
        .from("product_depot_mapping")
        .select(DEPOT_MAPPING_COLUMNS)
        .eq("depot_code", party?.code ?? "")
        .eq("is_active", true),
    ]);
    const codeFor = (sku: string): string | null =>
      party ? xeroItemCodeFor(party, sku, (mapping ?? []) as DepotProduct[]) : null;

    body = JSON.stringify({
      po_id: po.id,
      po_number: po.po_number,
      master_ref: po.master_ref,
      reference_po_number: po.reference_po_number,
      leg: po.leg,
      tier: TIER_LABEL[po.leg] ?? po.leg,
      from_entity: po.from_entity,
      to_entity: po.to_entity,
      parent_po_id: po.parent_po_id,
      delivery_address: po.delivery_address,
      approved_by: approver.label,
      approved_by_uid: approver.uid,
      /** The Xero organisation this order belongs in. Null only when the party is unmapped,
       *  which create-po refuses, so n8n falling back should never happen and is worth an
       *  execution log if it does. */
      xero_tenant_id: (tenantRow as { xero_tenant_id?: string | null } | null)?.xero_tenant_id ?? null,
      raising_party: party?.code ?? null,
      lines: (po.lines ?? []).map((l) => ({
        sku: l.sku,
        product_name: l.product_name,
        quantity: l.quantity,
        hs_code: l.hs_code,
        unit_price: l.unit_price,
        /** The ItemCode Xero must receive for THIS party. */
        xero_item_code: codeFor(l.sku),
      })),
      /** null = render failed; n8n creates the order and skips the attach. */
      attachment,
    });
  } catch (error) {
    console.error("handOffApprovedLeg: the payload could not be built", error);
    return { sent: false, reason: "failed", error: "The Hub could not put the order together for n8n, so nothing was sent." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), XERO_SEND_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.N8N_PO_APPROVED_WEBHOOK_SECRET
          ? { "x-hub-secret": process.env.N8N_PO_APPROVED_WEBHOOK_SECRET }
          : {}),
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.ok) return { sent: true };
    // The body goes to the server log only. What a screen shows is chosen from the status, so
    // nothing n8n says, and nothing about the address, can reach a page.
    const detail = await res.text().catch(() => "");
    console.error("handOffApprovedLeg: n8n refused", res.status, detail.slice(0, 300));
    return { sent: false, reason: "failed", error: refusalReason(res.status) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        sent: false,
        reason: "timed_out",
        error: `n8n did not answer within ${XERO_SEND_TIMEOUT_MS / 1000} seconds.`,
      };
    }
    return { sent: false, reason: "failed", error: unreachableReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** What a non-2xx answer means, in words somebody can act on. */
function refusalReason(status: number): string {
  if (status === 401 || status === 403) {
    return `n8n refused the Hub's secret (HTTP ${status}). The secret on the server and the one in n8n do not match.`;
  }
  if (status === 404) {
    return "n8n has no live workflow at the hand-off address (HTTP 404). It may be switched off.";
  }
  if (status >= 500) {
    return `The n8n workflow stopped with an error (HTTP ${status}). Its execution log in n8n says which step.`;
  }
  return `n8n answered HTTP ${status}.`;
}

/** No answer at all. The system error code, when there is one, says whether it was DNS or a refusal. */
function unreachableReason(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)
    ? `The Hub could not reach n8n (${code}).`
    : "The Hub could not reach n8n.";
}

/**
 * Write the attempt down. Read, then write: the approval posts a leg once, under the approval
 * RPC's row lock, and a retry posts only while it holds the leg's claim, so no two writers ever
 * meet here. The same write gives the claim back.
 */
async function recordAttempt(poId: string, actorUid: string, result: HandoffResult): Promise<void> {
  if (!result.sent && result.reason === "staging") return;
  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("po_xero_sends")
      .select("attempts")
      .eq("po_id", poId)
      .maybeSingle<{ attempts: number | null }>();
    const { error } = await admin.from("po_xero_sends").upsert(
      {
        po_id: poId,
        attempts: (existing?.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_attempt_by_uid: actorUid,
        last_outcome: result.sent ? "accepted" : result.reason,
        last_error: result.sent ? null : result.error,
        claimed_at: null,
      },
      { onConflict: "po_id" },
    );
    if (error) console.error("handOffApprovedLeg: the attempt was not recorded", error.message);
  } catch (error) {
    console.error("handOffApprovedLeg: the attempt was not recorded", error);
  }
}
