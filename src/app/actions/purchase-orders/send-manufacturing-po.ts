"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { externalCallsDisabled, hubBaseUrl } from "@/lib/env";
import { resolveRecipients, sendDescription } from "@/lib/email-recipients";
import { loadSroPoBom } from "@/lib/bom";
import { buildBamidaPo, type BamidaSupplier } from "@/lib/bamida-po";
import { buildBamidaPoPdf, bamidaPoPdfFilename } from "@/lib/bamida-po-pdf";
import { getSupplierByCode } from "@/lib/suppliers";
import { assessOrderCapability } from "@/lib/manufacturing-capability";

// Email the manufacturing order to Bamida.
//
// SENDING IS CLAIMED, NOT LABELLED. Writing sent_at afterwards and relabelling
// the button "Resend" is a label: a double click, a retry or a page refresh
// still sends twice, and a factory receiving the same purchase order twice is a
// real operational problem.
//
// So the claim happens BEFORE anything reaches n8n, and it is one conditional
// update: sent_at moves off null exactly once. Of two requests racing, one gets
// a row back and sends; the other gets none and returns "already sent" without
// contacting n8n at all. A disabled button only ever guards the polite case;
// this holds when both requests read the same state before either writes.
//
// If the send then fails, the claim is handed back so a retry can work. Nothing
// went out, so there is nothing that could be duplicated.
//
// SHORT MATERIALS DO NOT BLOCK, by Dean's decision on 8 Sep 2026. They change
// which template n8n uses: "we want to manufacture, we have detected you do not
// have enough materials, here is what we make short". The same webhook copies
// us, and the Hub records what it believed was short at the moment it sent.
//
// Recipients are decided here, not in n8n. A workflow holding its own copy of
// Bamida's address would email a factory while the Hub believed everything was
// going to the test address.

const Schema = z.object({ manufacturing_po_id: z.string().uuid("Invalid PO id") });

const TIMEOUT_MS = 30_000;

export type SendManufacturingPoResult =
  | { ok: true; description: string; wasTest: boolean; short: boolean }
  | { ok: false; error: string };

export async function sendManufacturingPoToBamida(
  input: z.infer<typeof Schema>,
): Promise<SendManufacturingPoResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { ok: false, error: "Forbidden: missing po.create capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const poId = parsed.data.manufacturing_po_id;

  const supabase = await createServerClient();
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_number, master_ref, leg, parent_po_id, reference_po_number, lines:purchase_order_lines(sku, product_name, quantity)")
    .eq("id", poId)
    .maybeSingle<{
      id: string;
      po_number: string;
      master_ref: string | null;
      leg: string;
      parent_po_id: string | null;
      reference_po_number: string | null;
      lines?: Array<{ sku: string | null; product_name: string | null; quantity: number | null }>;
    }>();
  if (!po) return { ok: false, error: "Manufacturing order not found." };
  if (po.leg !== "SRO_TO_SUPPLIER") {
    return { ok: false, error: "Only a manufacturing order can be sent to Bamida." };
  }
  if (!po.parent_po_id) {
    return { ok: false, error: "This manufacturing order has no SRO order behind it." };
  }

  const webhookUrl = String(process.env.N8N_BAMIDA_PO_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return { ok: false, error: "The Bamida webhook is not configured on the server." };
  if (externalCallsDisabled()) {
    return { ok: false, error: "Sandbox (staging): nothing is sent to Bamida from here." };
  }

  const bamidaTo = String(process.env.BAMIDA_PO_TO ?? "").trim();
  if (!bamidaTo) {
    return {
      ok: false,
      error: "Bamida's email address is not configured on the server (BAMIDA_PO_TO).",
    };
  }

  // --- The document -------------------------------------------------------
  // The BOM hangs off the PARENT SRO order, which is what carries the frozen
  // cost snapshot and the exploded lines.
  const bom = await loadSroPoBom(po.parent_po_id);
  if (!bom) {
    return {
      ok: false,
      error: "The bill of materials for this order could not be read, so there is nothing to send.",
    };
  }
  const supplierRow = await getSupplierByCode("BAMIDA, s.r.o.").catch(() => null);
  const addressLines = (supplierRow?.address ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const supplier: BamidaSupplier | undefined =
    supplierRow && addressLines.length
      ? { name: supplierRow.name, address: addressLines, taxNumber: supplierRow.tax_number ?? undefined }
      : undefined;

  const bamida = buildBamidaPo(bom, new Date().toISOString().slice(0, 10), supplier);
  if (bamida.lines.length === 0) {
    return {
      ok: false,
      error: "This order explodes to no BOM lines, so the document would be empty. Check the SKU to model mapping.",
    };
  }

  // --- Can they build it --------------------------------------------------
  const capability = await assessOrderCapability(po.lines ?? []);
  const shortMaterials = capability.lines
    .filter((l) => l.shortages.length > 0)
    .map((l) => ({ sku: l.sku, quantity: l.quantity, short: l.shortages }));

  // --- Claim the send BEFORE anything leaves ------------------------------
  const admin = createAdminClient();
  const recipients = resolveRecipients({
    to: bamidaTo,
    cc: process.env.BAMIDA_PO_CC,
    bcc: process.env.BAMIDA_PO_BCC,
  });

  // Make sure the row exists, without claiming anything. A row may already be
  // here from an earlier send that was deliberately released.
  const { error: ensureErr } = await admin
    .from("po_manufacturing")
    .upsert({ po_id: poId }, { onConflict: "po_id", ignoreDuplicates: true });
  if (ensureErr) {
    console.error("sendManufacturingPoToBamida row failed", ensureErr.message);
    return { ok: false, error: "The send could not be recorded, so nothing was sent." };
  }

  // THE CLAIM. One conditional update: sent_at moves off null exactly once, so
  // of two requests racing here, one gets a row back and the other gets none.
  const { data: claimed, error: claimErr } = await admin
    .from("po_manufacturing")
    .update({
      sent_at: new Date().toISOString(),
      sent_by_uid: auth.user.id,
      sent_to: recipients.to,
      sent_was_test: recipients.isTest,
      short_materials: shortMaterials.length > 0 ? shortMaterials : null,
    })
    .eq("po_id", poId)
    .is("sent_at", null)
    .select("po_id");
  if (claimErr) {
    console.error("sendManufacturingPoToBamida claim failed", claimErr.message);
    return { ok: false, error: "The send could not be recorded, so nothing was sent." };
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: "This order has already been sent to Bamida." };
  }

  // --- Send ---------------------------------------------------------------
  const doc = await buildBamidaPoPdf(bamida);
  const bytes = Buffer.from(doc.output("arraybuffer") as ArrayBuffer);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let failure: string | null = null;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET
          ? { "x-hub-secret": process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify({
        action: "send_manufacturing_po",
        /** Which wording n8n uses. Short materials never stop the send. */
        template: shortMaterials.length > 0 ? "materials_short" : "standard",
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        is_test: recipients.isTest,
        intended: recipients.intended,
        po_id: po.id,
        po_number: po.po_number,
        master_ref: po.master_ref,
        reference_po_number: po.reference_po_number,
        /** Where Bamida record their dates and press finished. Filled by A5. */
        link: `${hubBaseUrl()}/manufacturing`,
        pallets: bamida.pallets,
        lines: (po.lines ?? []).map((l) => ({
          sku: l.sku,
          product_name: l.product_name,
          quantity: l.quantity,
        })),
        short_materials: shortMaterials,
        attachment: {
          filename: bamidaPoPdfFilename(bamida),
          content_base64: bytes.toString("base64"),
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.status === 401) failure = "The Bamida webhook rejected the Hub: the webhook secret does not match n8n.";
    else if (!res.ok) failure = `Sending the order to Bamida failed (HTTP ${res.status}).`;
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    failure = aborted
      ? "The Bamida mail workflow did not respond in time."
      : "The Bamida mail workflow could not be reached.";
  } finally {
    clearTimeout(timer);
  }

  if (failure) {
    // Nothing went out, so give the claim back rather than leaving the order
    // permanently unsendable. Only this caller can be here: whoever lost the
    // claim above never reached the network.
    await admin.from("po_manufacturing").update({ sent_at: null }).eq("po_id", poId);
    return { ok: false, error: failure };
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${poId}`);
  return {
    ok: true,
    description: sendDescription(recipients),
    wasTest: recipients.isTest,
    short: shortMaterials.length > 0,
  };
}

/**
 * Send it again, on purpose.
 *
 * Releasing the claim is its own action with its own button precisely so that a
 * resend is always a decision. Everything else about the send is designed to
 * make a second one impossible by accident; this is the one door, and it is
 * shut once Bamida have said the order is finished.
 */
export async function releaseBamidaSendClaim(
  input: z.infer<typeof Schema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { ok: false, error: "Forbidden: missing po.create capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { data: released, error } = await createAdminClient()
    .from("po_manufacturing")
    .update({ sent_at: null })
    .eq("po_id", parsed.data.manufacturing_po_id)
    .not("sent_at", "is", null)
    .is("finished_at", null)
    .select("po_id");
  if (error) {
    console.error("releaseBamidaSendClaim failed", error.message);
    return { ok: false, error: "The order could not be reopened for sending." };
  }
  if (!released || released.length === 0) {
    return {
      ok: false,
      error: "There is nothing to resend: this order has either not been sent, or Bamida have already finished it.",
    };
  }

  revalidatePath(`/purchase-orders/${parsed.data.manufacturing_po_id}`);
  return { ok: true };
}
