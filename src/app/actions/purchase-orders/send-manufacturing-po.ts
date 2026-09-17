"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { poChainHeldBy } from "@/lib/po-organisations";
import { specDocumentStatus } from "@/lib/po-spec-store";
import { loadSendContacts, resolveSelection } from "@/lib/send-contacts";
import { externalCallsDisabled, hubBaseUrl } from "@/lib/env";
import { resolveRecipients, sendDescription } from "@/lib/email-recipients";
import { loadSroPoBom } from "@/lib/bom";
import { buildBamidaPo, type BamidaSupplier } from "@/lib/bamida-po";
import { getSupplierByCode } from "@/lib/suppliers";
import { assessOrderCapability } from "@/lib/manufacturing-capability";
import { addressesFrom, type PreviewAddress, type SendPreview } from "@/lib/send-preview";

// Tell the manufacturer a purchase order is waiting for them in the Hub.
//
// NO ATTACHMENT AND NO ONE-OFF LINK since 16 Sep 2026. Dean: "The purchase
// order no longer goes via pdf in the email. They can download the purchase
// order in the manufacturing tab next to the relevant one", and "not to have
// the pdf attached but rather link to the hub with their login". So this is a
// notification now, not a delivery: the document, the dates and the finished
// button all live behind their own login, which means one copy of the order
// that cannot drift from ours, and no emailed link to mislay or forward.
//
// The bill of materials is still read before anything is sent, because an order
// whose document cannot be built is an order they cannot download, and telling
// them about it would waste a trip.
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

// 🔴 EXTRA ADDRESSES ADD. THEY NEVER REPLACE.
//
// Dean, 9 Sep 2026, asked for typeable addresses. Dean, 17 Sep 2026, fixed the recipient:
// "sklad@bamida.sk / It should no longer be an editable field." Then, the same day: "readd the
// ability to enter email addresses for to and CC which will append to the existing ones just make
// it clear that [the four] is automatically CCed."
//
// The difference from the original is the whole point. `to` and `cc` used to REPLACE, which meant
// any caller of this 'use server' export could have the Hub send a real purchase order, on Echo
// Barrier letterhead, to an address of its choosing and to nobody else. Now the factory's address
// and the four internal copies are decided on the server and always go out; whatever arrives here
// is merged on top and deduplicated. There is no input that can remove a recipient.
const Schema = z.object({
  manufacturing_po_id: z.string().uuid("Invalid PO id"),
  /** Address book rows that were ticked. Required rows go whether or not their id is here. */
  contact_ids: z.array(z.string().uuid()).max(100).optional(),
  /** Comma separated, for somebody not in the book. ADDED, never instead of. */
  to: z.string().trim().max(400).optional(),
  cc: z.string().trim().max(400).optional(),
});

const TIMEOUT_MS = 30_000;

export type SendManufacturingPoResult =
  | { ok: true; description: string; wasTest: boolean; short: boolean }
  | { ok: false; error: string };

/**
 * Everything the send works out BEFORE it claims anything or contacts n8n.
 *
 * Split out on 16 Sep 2026 so that the confirmation dialog and the send itself
 * are the same reasoning. A preview computed by a second, similar-looking
 * function is a preview that can quietly stop describing the send, and the one
 * time it matters is the time somebody is relying on it.
 *
 * The return type is inferred rather than declared, so a field added to the plan
 * reaches both callers without a type to keep in step.
 */
async function planManufacturingSend(input: z.infer<typeof Schema>) {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false as const, error: auth.error };
  if (!auth.capabilities.has("po.create")) {
    return { ok: false as const, error: "Forbidden: missing po.create capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
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
  if (!po) return { ok: false as const, error: "Manufacturing order not found." };
  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false as const, error: "Manufacturing order not found." };
  }
  if (po.leg !== "SRO_TO_SUPPLIER") {
    return { ok: false as const, error: "Only a manufacturing order can be sent to Bamida." };
  }
  if (!po.parent_po_id) {
    return { ok: false as const, error: "This manufacturing order has no SRO order behind it." };
  }

  // 🔴 NOTHING GOES UNSIGNED, and a disabled button is not a gate: every export of a 'use server'
  // file is a public endpoint, so the refusal has to live here.
  //
  // Dean, 17 Sep 2026: "what if they click on Manufacturing PO (PDF) see the spec is good then
  // press on send to bamida without going into Edit Specification first to save it. Then does it
  // send with that red line?" It did. The factory would have downloaded a build sheet headed
  // SPECIFICATION NOT YET CONFIRMED, which is exactly the document the whole sign-off exists to
  // prevent reaching them. Confirming is one press on the specification page.
  const spec = await specDocumentStatus(poId);
  if (!spec.confirmedAt) {
    return {
      ok: false as const,
      error: spec.saved
        ? "The manufacturing specification has been saved but not confirmed. Open Review specification and confirm it, then send."
        : "Confirm the manufacturing specification before sending this order. Open Review specification, check it and press Confirm.",
    };
  }

  const webhookUrl = String(process.env.N8N_BAMIDA_PO_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return { ok: false as const, error: "The Bamida webhook is not configured on the server." };
  if (externalCallsDisabled()) {
    return { ok: false as const, error: "Sandbox (staging): nothing is sent to Bamida from here." };
  }

  // The address book decides, not the browser. Required rows are merged in whatever arrives, so
  // nothing a caller sends can drop the manufacturer's own desk or the four Dean named.
  const book = await loadSendContacts("manufacturing");
  const typedTo = String(parsed.data.to ?? "").trim();
  const typedCc = String(parsed.data.cc ?? "").trim();
  const chosen = resolveSelection(book, parsed.data.contact_ids ?? [], { to: typedTo, cc: typedCc });
  const bamidaTo = chosen.to;
  const bamidaCc = chosen.cc;

  if (!bamidaTo) {
    return {
      ok: false as const,
      error: "Nobody to send it to. The address book has no recipient for a manufacturing order.",
    };
  }

  // WHERE EACH ADDRESS CAME FROM, so the confirmation dialog can say it line by line. Worked out
  // here because here is where the choice is made.
  const fromBook = (field: "to" | "cc") =>
    chosen.used
      .filter((c) => c.field === field)
      .flatMap((c) =>
        addressesFrom(
          c.address,
          "server",
          c.isRequired ? "always copied" : `address book${c.organisation ? `, ${c.organisation}` : ""}`,
        ),
      );

  // Same rule as the merge: first spelling wins, so an address that is both ticked and typed is
  // printed once and the reader is not left wondering which one is real.
  const once = (entries: PreviewAddress[]) => {
    const seen = new Set<string>();
    return entries.filter((e) => {
      const key = e.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const real = {
    to: once([...fromBook("to"), ...addressesFrom(typedTo, "typed", "the Also send to box")]),
    cc: once([...fromBook("cc"), ...addressesFrom(typedCc, "typed", "the Also copy to box")]),
    // Never on any screen. A blind copy nobody remembers is the whole reason
    // this dialog prints every address.
    bcc: addressesFrom(process.env.BAMIDA_PO_BCC, "server", "BAMIDA_PO_BCC"),
  };

  // --- Can the document be built at all -----------------------------------
  // The BOM hangs off the PARENT SRO order, which is what carries the frozen
  // cost snapshot and the exploded lines. Nothing here is emailed any more; it
  // is read so that an order whose document would be empty is never announced,
  // and for the pallet count the wording uses.
  const bom = await loadSroPoBom(po.parent_po_id);
  if (!bom) {
    return {
      ok: false as const,
      error: "The bill of materials for this order could not be read, so there is nothing to send.",
    };
  }
  const supplierRow = await getSupplierByCode("BAMIDA, s.r.o.").catch(() => null);
  const addressLines = (supplierRow?.address ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const supplier: BamidaSupplier | undefined =
    supplierRow && addressLines.length
      ? { name: supplierRow.name, address: addressLines, taxNumber: supplierRow.tax_number ?? undefined }
      : undefined;

  // `po` IS the manufacturing order, so its own number (EBSRO8001-1) is the one
  // that goes on the document Bamida receive; `bom` belongs to its SRO parent.
  const bamida = buildBamidaPo(bom, new Date().toISOString().slice(0, 10), supplier, po.po_number);
  if (bamida.lines.length === 0) {
    return {
      ok: false as const,
      error: "This order explodes to no BOM lines, so the document would be empty. Check the SKU to model mapping.",
    };
  }

  // --- Can they build it --------------------------------------------------
  const capability = await assessOrderCapability(po.lines ?? []);
  const shortMaterials = capability.lines
    .filter((l) => l.shortages.length > 0)
    .map((l) => ({ sku: l.sku, quantity: l.quantity, short: l.shortages }));

  const recipients = resolveRecipients({
    to: bamidaTo,
    cc: bamidaCc,
    bcc: process.env.BAMIDA_PO_BCC,
  });

  return {
    ok: true as const,
    plan: { po, poId, webhookUrl, recipients, real, pallets: bamida.pallets, shortMaterials, actorId: auth.user.id },
  };
}

/**
 * What pressing Send is about to do, for the dialog that asks whether to.
 *
 * Dean, 16 Sep 2026: "add second confirmation before sending to Manufacturing on
 * the email and the contents of the email ... along with CC everything and where
 * it comes from."
 *
 * It CLAIMS NOTHING and POSTS NOTHING. Every gate the send passes, this passes
 * first, because an export of a 'use server' file is a callable endpoint and
 * this one reads an order's lines.
 */
export async function previewManufacturingPoSend(
  input: z.infer<typeof Schema>,
): Promise<{ ok: true; preview: SendPreview } | { ok: false; error: string }> {
  const planned = await planManufacturingSend(input);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { po, recipients, real, pallets, shortMaterials } = planned.plan;

  const lines = (po.lines ?? []).map((l) => ({
    name: l.product_name ?? "Unnamed product",
    quantity: l.quantity === null ? "" : String(l.quantity),
  }));

  const warnings: string[] = [];
  if (shortMaterials.length > 0) {
    warnings.push(
      `The email will also tell them that ${shortMaterials.length} ${shortMaterials.length === 1 ? "line is" : "lines are"} short of materials.`,
    );
  }
  if (real.cc.length === 0) {
    warnings.push("Nobody is copied on this email.");
  }

  return {
    ok: true,
    preview: {
      what: "a purchase order to the manufacturer",
      to: real.to,
      cc: real.cc,
      bcc: real.bcc,
      isTest: recipients.isTest,
      instead: recipients.intended,
      facts: [
        { label: "Purchase order", value: po.po_number },
        ...(po.reference_po_number ? [{ label: "Their reference", value: po.reference_po_number }] : []),
        { label: "Pallets", value: String(pallets) },
        { label: "They open", value: `${hubBaseUrl()}/factory/${po.id}`, wide: true },
      ],
      lines,
      warnings,
    },
  };
}

export async function sendManufacturingPoToBamida(
  input: z.infer<typeof Schema>,
): Promise<SendManufacturingPoResult> {
  const planned = await planManufacturingSend(input);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { po, poId, webhookUrl, recipients, pallets, shortMaterials, actorId } = planned.plan;

  // --- Claim the send BEFORE anything leaves ------------------------------
  const admin = createAdminClient();

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
      sent_by_uid: actorId,
      sent_to: recipients.to,
      sent_was_test: recipients.isTest,
      // The real audience, which sent_to is not while the test switch is on.
      // The confirmation email reads these back, so it reaches the people the
      // order was addressed to and not whichever account pressed Confirm.
      intended_to: recipients.intended?.to ?? recipients.to,
      intended_cc: recipients.intended?.cc ?? recipients.cc,
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
        /**
         * Where they sign in, download the order, confirm it with their dates
         * and later press finished. A plain Hub address behind their own
         * login, so it does not expire, cannot be forwarded into somebody
         * else's hands, and always shows the order as it stands now.
         */
        link: `${hubBaseUrl()}/factory/${po.id}`,
        pallets,
        /**
         * No SKU. `EBH9NA` is our own database code and means nothing to a
         * factory, so it does not travel: not printed, and not carried in the
         * payload either, because the webhook body is readable in every n8n
         * execution log.
         */
        lines: (po.lines ?? []).map((l) => ({
          product_name: l.product_name,
          quantity: l.quantity,
        })),
        short_materials: shortMaterials,
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
  if (!(await poChainHeldBy(parsed.data.manufacturing_po_id, auth.profile.organisations))) {
    return { ok: false, error: "Manufacturing order not found." };
  }

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
