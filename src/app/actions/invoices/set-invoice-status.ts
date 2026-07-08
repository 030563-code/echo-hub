"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";

// Commercial-invoice lifecycle: draft → issued, and draft/issued → void.
// invoice.create-gated (issuing/voiding is a create-adjacent authority). The
// transition is validated server-side against the current status so the UI can
// never force an illegal jump. Voiding frees the (container_ref, leg) live-unique
// slot so a corrected invoice can be re-generated.

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
