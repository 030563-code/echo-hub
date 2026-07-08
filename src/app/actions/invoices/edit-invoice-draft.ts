"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { reconcileInvoiceLines } from "@/lib/commercial-invoice";

// Editable-draft override. Lets a finance user hand-adjust a DRAFT invoice's
// lines before issuing — consolidate (delete ancillary lines + fold their value
// into a product), split (add lines), correct a price, or set an HS code — as a
// first-class, SAFE feature:
//   • DRAFT ONLY (an issued/void document is immutable).
//   • Totals are RECONCILED server-side from the edited lines (never drift).
//   • Every edit is AUDITED (before/after) to commercial_invoice_edit_log.
// Gated invoice.create AND cost.view (values are edited). Writes via service-role
// after the gate (the lines/header tables are service-role-write only).

const LineSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  product_name: z.string().trim().min(1).max(300),
  qty: z.number().nonnegative().max(1_000_000),
  unit_value: z.number().nonnegative().max(100_000_000),
  hs_code: z.string().trim().max(60).nullable().optional(),
});

const Schema = z.object({
  invoice_id: z.string().uuid(),
  lines: z.array(LineSchema).min(1, "An invoice needs at least one line").max(200),
});

export type EditInvoiceDraftResult = { ok: true; subtotal: number; total: number } | { ok: false; error: string };

export async function editInvoiceDraft(input: z.infer<typeof Schema>): Promise<EditInvoiceDraftResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!auth.capabilities.has("invoice.create") || !auth.capabilities.has("cost.view")) {
    return { ok: false, error: "Forbidden: needs invoice.create + cost.view" };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { invoice_id, lines } = parsed.data;

  const admin = createAdminClient();

  // Draft-only guard + current state (for tax carry-through + the audit "before").
  const { data: inv, error: readErr } = await admin
    .from("commercial_invoices")
    .select("id, status, tax_total, container_ref")
    .eq("id", invoice_id)
    .maybeSingle();
  if (readErr || !inv) return { ok: false, error: "Invoice not found." };
  const header = inv as { id: string; status: string; tax_total: number | string; container_ref: string | null };
  if (header.status !== "draft") {
    return { ok: false, error: `Only a draft invoice can be edited (this one is '${header.status}'). Void it to re-issue.` };
  }

  const { data: beforeLines } = await admin
    .from("commercial_invoice_lines")
    .select("sku, product_name, qty, unit_value, line_total, hs_code, sort_order")
    .eq("invoice_id", invoice_id)
    .order("sort_order", { ascending: true });

  // Reconcile totals from the edited lines (rounds unit first → line_total exact).
  const taxTotal = Number(header.tax_total) || 0;
  const recon = reconcileInvoiceLines(
    lines.map((l) => ({ sku: l.sku, product_name: l.product_name, qty: l.qty, unit_value: l.unit_value, hs_code: l.hs_code ?? null })),
    taxTotal
  );

  // Replace lines atomically-ish (service-role): delete then insert the new set.
  const { error: delErr } = await admin.from("commercial_invoice_lines").delete().eq("invoice_id", invoice_id);
  if (delErr) return { ok: false, error: "Could not update the invoice lines." };

  const { error: insErr } = await admin.from("commercial_invoice_lines").insert(
    recon.lines.map((l, i) => ({
      invoice_id,
      sku: l.sku,
      product_name: l.product_name,
      qty: l.qty,
      unit_value: l.unit_value,
      line_total: l.line_total,
      hs_code: l.hs_code,
      container_ref: header.container_ref,
      sort_order: i,
    }))
  );
  if (insErr) return { ok: false, error: "Could not save the edited lines." };

  const { error: upErr } = await admin
    .from("commercial_invoices")
    .update({ subtotal: recon.subtotal, total: recon.total, updated_at: new Date().toISOString() })
    .eq("id", invoice_id)
    .eq("status", "draft"); // never touch a doc that was issued concurrently
  if (upErr) return { ok: false, error: "Could not update the invoice totals." };

  // Audit the override (best-effort — the edit already committed).
  try {
    await admin.from("commercial_invoice_edit_log").insert({
      invoice_id,
      edited_by: auth.user.id,
      edited_by_label: auth.user.email ?? "Hub user",
      before: { lines: beforeLines ?? [] },
      after: { lines: recon.lines, subtotal: recon.subtotal, total: recon.total },
    });
  } catch (e) {
    console.error("commercial_invoice_edit_log insert failed", e);
  }

  revalidatePath("/invoices");
  revalidatePath("/transport");
  return { ok: true, subtotal: recon.subtotal, total: recon.total };
}
