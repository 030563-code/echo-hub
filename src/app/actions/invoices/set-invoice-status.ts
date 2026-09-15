"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { holdsOrganisation } from "@/lib/organisations";
import { issueBlockedReason } from "@/lib/hs-codes";

// Commercial-invoice lifecycle: draft → issued, and draft/issued → void.
// invoice.create-gated (issuing/voiding is a create-adjacent authority). The
// transition is validated server-side against the current status so the UI can
// never force an illegal jump. Voiding frees the (container_ref, leg) live-unique
// slot so a corrected invoice can be re-generated.
//
// Issuing also needs every line to carry an HS code (Dean, 14 Sep 2026). The
// list and the draft editor show the same rule, but this is where it holds.
// Voiding stays allowed whatever the lines say.
//
// Issuing goes through hub_issue_commercial_invoice, which takes the invoice row
// FOR UPDATE, re-checks draft, checks the HS codes and flips the status in one
// transaction. editInvoiceDraft replaces lines under the same lock, so an edit
// racing an issue can never rewrite the lines of an invoice that was just issued.

const Schema = z.object({
  invoice_id: z.string().uuid(),
  action: z.enum(["issue", "void"]),
});

export type SetInvoiceStatusResult = { ok: true; status: string } | { ok: false; error: string };

const ALLOWED: Record<string, Record<string, string>> = {
  draft: { issue: "issued", void: "void" },
  issued: { void: "void" },
};

export async function setInvoiceStatus(input: z.infer<typeof Schema>): Promise<SetInvoiceStatusResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("invoice.create")) {
    return { ok: false, error: "Forbidden: missing invoice.create capability" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { invoice_id, action } = parsed.data;

  const admin = createAdminClient();
  const { data: inv, error: readErr } = await admin
    .from("commercial_invoices")
    .select("id, status, seller_entity_code, buyer_entity_code")
    .eq("id", invoice_id)
    .maybeSingle();
  if (readErr || !inv) return { ok: false, error: "Invoice not found." };
  const row = inv as { status: string; seller_entity_code: string; buyer_entity_code: string };
  const held = auth.profile.organisations;
  if (!holdsOrganisation(held, row.seller_entity_code) && !holdsOrganisation(held, row.buyer_entity_code)) {
    return { ok: false, error: "Invoice not found." };
  }

  const current = row.status;
  const next = ALLOWED[current]?.[action];
  if (!next) return { ok: false, error: `Cannot ${action} an invoice that is '${current}'.` };

  if (action === "issue") {
    const { data, error: rpcErr } = await admin.rpc("hub_issue_commercial_invoice", { p_invoice_id: invoice_id });
    if (rpcErr || !data) return { ok: false, error: "Could not issue the invoice." };
    const res = data as IssueRpcResult;
    if (!res.ok) return { ok: false, error: issueRefusal(res) };
  } else {
    const { error: upErr } = await admin
      .from("commercial_invoices")
      .update({ status: next })
      .eq("id", invoice_id)
      .eq("status", current); // optimistic guard against a concurrent transition
    if (upErr) return { ok: false, error: "Failed to update the invoice status." };
  }

  revalidatePath("/invoices");
  revalidatePath("/transport");
  return { ok: true, status: next };
}

type IssueRpcLine = { sku: string; product_name: string | null; hs_code: string | null };

/** What hub_issue_commercial_invoice returns. */
type IssueRpcResult =
  | { ok: true; status: "issued" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_draft"; status: string }
  | { ok: false; reason: "no_lines" }
  | { ok: false; reason: "missing_hs_codes"; missing_skus: string[]; lines: IssueRpcLine[] };

function issueRefusal(res: Exclude<IssueRpcResult, { ok: true }>): string {
  switch (res.reason) {
    case "not_found":
      return "Invoice not found.";
    case "not_draft":
      return `Cannot issue an invoice that is '${res.status}'.`;
    case "no_lines":
      return "This invoice has no lines, so it cannot be issued.";
    case "missing_hs_codes":
      return issueBlockedReason(res.lines ?? []) ?? "This invoice cannot be issued: a line has no HS code.";
    default:
      return "Could not issue the invoice.";
  }
}
