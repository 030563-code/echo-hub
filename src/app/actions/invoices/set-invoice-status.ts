"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
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
    .select("id, status")
    .eq("id", invoice_id)
    .maybeSingle();
  if (readErr || !inv) return { ok: false, error: "Invoice not found." };

  const current = (inv as { status: string }).status;
  const next = ALLOWED[current]?.[action];
  if (!next) return { ok: false, error: `Cannot ${action} an invoice that is '${current}'.` };

  if (action === "issue") {
    const { data: lines, error: linesErr } = await admin
      .from("commercial_invoice_lines")
      .select("sku, product_name, hs_code, sort_order")
      .eq("invoice_id", invoice_id)
      .order("sort_order", { ascending: true });
    // A failed read must not look like "no lines, so nothing is missing".
    if (linesErr || !lines) return { ok: false, error: "Could not read the invoice lines, so it was not issued." };
    if (!lines.length) return { ok: false, error: "This invoice has no lines, so it cannot be issued." };
    const blocked = issueBlockedReason(lines as { sku: string; product_name: string | null; hs_code: string | null }[]);
    if (blocked) return { ok: false, error: blocked };
  }

  const { error: upErr } = await admin
    .from("commercial_invoices")
    .update({ status: next })
    .eq("id", invoice_id)
    .eq("status", current); // optimistic guard against a concurrent transition
  if (upErr) return { ok: false, error: "Failed to update the invoice status." };

  revalidatePath("/invoices");
  revalidatePath("/transport");
  return { ok: true, status: next };
}
