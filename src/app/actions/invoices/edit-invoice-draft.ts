"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { reconcileInvoiceLines } from "@/lib/commercial-invoice";
import { isValidHsCode, normaliseHsCode } from "@/lib/hs-codes";

// Editable-draft override. Lets a finance user hand-adjust a DRAFT invoice's
// lines before issuing — consolidate (delete ancillary lines + fold their value
// into a product), split (add lines), correct a price, or set an HS code — as a
// first-class, SAFE feature:
//   • DRAFT ONLY (an issued/void document is immutable).
//   • Totals are RECONCILED server-side from the edited lines (never drift).
//   • Every edit is AUDITED (before/after) to commercial_invoice_edit_log.
// Gated invoice.create AND cost.view (values are edited). Writes via service-role
// after the gate (the lines/header tables are service-role-write only).
//
// The lines and totals are replaced by hub_replace_commercial_invoice_lines,
// which takes the invoice row FOR UPDATE and re-checks draft before it deletes
// and inserts, all in one transaction. setInvoiceStatus issues under the same
// lock, so an edit that races an issue either lands before it (and the issue
// checks the edited lines) or is refused after it. The "before" for the edit
// log is the set of lines the function replaced, read under that lock.

const LineSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  product_name: z.string().trim().min(1).max(300),
  qty: z.number().nonnegative().max(1_000_000),
  unit_value: z.number().nonnegative().max(100_000_000),
  // Blank means "no code yet" (the draft saves, but cannot be issued). Anything
  // typed must pass the same format rule as product_hs_codes.
  hs_code: z
    .string()
    .max(60)
    .nullable()
    .optional()
    .transform((v) => normaliseHsCode(v) || null)
    .refine((v) => v === null || isValidHsCode(v), {
      message: "An HS code is 6 to 10 digits, split by single dots or spaces, e.g. 3926.90 or 3926 90 97.",
    }),
});

const Schema = z.object({
  invoice_id: z.string().uuid(),
  lines: z.array(LineSchema).min(1, "An invoice needs at least one line").max(200),
});

export type EditInvoiceDraftResult = { ok: true; subtotal: number; total: number } | { ok: false; error: string };

export async function editInvoiceDraft(input: z.input<typeof Schema>): Promise<EditInvoiceDraftResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("invoice.create") || !auth.capabilities.has("cost.view")) {
    return { ok: false, error: "Forbidden: needs invoice.create + cost.view" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { invoice_id, lines } = parsed.data;

  const admin = createAdminClient();

  // An early draft-only refusal, and the tax to carry through. The function
  // below checks draft again under the row lock, which is the check that holds.
  const { data: inv, error: readErr } = await admin
    .from("commercial_invoices")
    .select("id, status, tax_total")
    .eq("id", invoice_id)
    .maybeSingle();
  if (readErr || !inv) return { ok: false, error: "Invoice not found." };
  const header = inv as { id: string; status: string; tax_total: number | string };
  if (header.status !== "draft") {
    return { ok: false, error: `Only a draft invoice can be edited (this one is '${header.status}'). Void it to re-issue.` };
  }

  // Reconcile totals from the edited lines (rounds unit first, so line_total is exact).
  const taxTotal = Number(header.tax_total) || 0;
  const recon = reconcileInvoiceLines(
    lines.map((l) => ({ sku: l.sku, product_name: l.product_name, qty: l.qty, unit_value: l.unit_value, hs_code: l.hs_code ?? null })),
    taxTotal
  );

  const { data: replaced, error: rpcErr } = await admin.rpc("hub_replace_commercial_invoice_lines", {
    p_invoice_id: invoice_id,
    p_lines: recon.lines.map((l, i) => ({
      sku: l.sku,
      product_name: l.product_name,
      qty: l.qty,
      unit_value: l.unit_value,
      line_total: l.line_total,
      hs_code: l.hs_code,
      sort_order: i,
    })),
    p_header: { subtotal: recon.subtotal, total: recon.total },
  });
  if (rpcErr || !replaced) return { ok: false, error: "Could not save the edited lines." };
  const result = replaced as ReplaceRpcResult;
  if (!result.ok) {
    if (result.reason === "not_draft") {
      return { ok: false, error: `Only a draft invoice can be edited (this one is '${result.status}'). Void it to re-issue.` };
    }
    if (result.reason === "not_found") return { ok: false, error: "Invoice not found." };
    return { ok: false, error: "An invoice needs at least one line" };
  }

  // Audit the override (best-effort — the edit already committed).
  try {
    await admin.from("commercial_invoice_edit_log").insert({
      invoice_id,
      edited_by: auth.user.id,
      edited_by_label: auth.user.email ?? "Hub user",
      before: { lines: result.before ?? [] },
      after: { lines: recon.lines, subtotal: recon.subtotal, total: recon.total },
    });
  } catch (e) {
    console.error("commercial_invoice_edit_log insert failed", e);
  }

  revalidatePath("/invoices");
  revalidatePath("/transport");
  return { ok: true, subtotal: recon.subtotal, total: recon.total };
}

/** What hub_replace_commercial_invoice_lines returns. */
type ReplaceRpcResult =
  | { ok: true; before: unknown[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_draft"; status: string }
  | { ok: false; reason: "no_lines" };
