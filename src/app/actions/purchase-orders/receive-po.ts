"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Partial-delivery: log a batch of received quantities against an approved PO's
// lines (append-only). A PO stays "open" (approved) until every line's Σ received
// ≥ ordered, at which point it flips to 'delivered'. Receipts are qty-only (no
// price) and do NOT touch the dummy warehouse_stock_levels. po.receive gated.
// ---------------------------------------------------------------------------

const ReceiveSchema = z.object({
  poId: z.string().uuid("Invalid PO id"),
  batchRef: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
  receivedAt: z.string().datetime().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        qty: z.number().int().positive().max(10_000_000),
      })
    )
    .min(1, "Log at least one received line"),
});

export type RecordReceiptInput = z.infer<typeof ReceiveSchema>;
export type RecordReceiptResult =
  | { success: true; fullyReceived: boolean }
  | { success: false; error: string };

interface POLineLite {
  id: string;
  sku: string;
  quantity: number;
}
interface POForReceive {
  id: string;
  status: string;
  source: string;
  leg: string;
  lines?: POLineLite[];
}

export async function recordReceipt(input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.receive")) {
    return { success: false, error: "Forbidden: missing po.receive capability" };
  }

  const parsed = ReceiveSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { poId, batchRef, note, receivedAt, lines } = parsed.data;
  const { user } = auth;
  const supabase = await createServerClient();

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, status, source, leg, lines:purchase_order_lines(id, sku, quantity)")
    .eq("id", poId)
    .maybeSingle<POForReceive>();

  if (!po) return { success: false, error: "Purchase order not found" };
  // Hub-owned rows only — never touch the legacy n8n flow's state (it has its own
  // 'approved' rows + state machine).
  if (po.source !== "hub") {
    return { success: false, error: "Receipts are only logged against Hub-managed POs." };
  }
  // The physical goods land at the DEPOT that ordered them, so receipts are logged
  // against the depot leg only — the Group→SRO legs are intercompany paperwork.
  if (po.leg !== "DEPOT_TO_EB_GROUP") {
    return { success: false, error: "Deliveries are received against the depot order, not an intercompany leg." };
  }
  if (po.status !== "approved") {
    return { success: false, error: "Deliveries can only be logged against an approved (open) PO." };
  }

  const poLines = new Map((po.lines ?? []).map((l) => [l.id, l]));

  // Already-received totals per line.
  const { data: prior } = await supabase
    .from("po_line_receipts")
    .select("po_line_id, qty_received")
    .eq("po_id", poId);
  const receivedByLine = new Map<string, number>();
  for (const r of prior ?? []) {
    receivedByLine.set(r.po_line_id, (receivedByLine.get(r.po_line_id) ?? 0) + r.qty_received);
  }

  // Validate + build receipt rows (reject over-receipt).
  const rows = [];
  for (const l of lines) {
    const poLine = poLines.get(l.lineId);
    if (!poLine) return { success: false, error: "A received line does not belong to this PO." };
    const remaining = poLine.quantity - (receivedByLine.get(l.lineId) ?? 0);
    if (l.qty > remaining) {
      return {
        success: false,
        error: `${poLine.sku}: receiving ${l.qty} exceeds the ${remaining} still outstanding.`,
      };
    }
    rows.push({
      po_id: poId,
      po_line_id: l.lineId,
      qty_received: l.qty,
      batch_ref: batchRef || null,
      note: note || null,
      received_at: receivedAt || new Date().toISOString(),
      received_by_uid: user.id,
    });
  }

  const { error: insErr } = await supabase.from("po_line_receipts").insert(rows);
  if (insErr) {
    console.error("recordReceipt insert failed", insErr.message);
    return { success: false, error: "Failed to log the delivery." };
  }

  // Recompute from the AUTHORITATIVE post-insert sum (re-read, don't trust the
  // pre-insert snapshot — a concurrent batch on another line could also have
  // completed the PO). Flip to 'delivered' when complete via service-role (the
  // authenticated approve policy only covers requested→approved/rejected).
  const { data: allReceipts } = await supabase
    .from("po_line_receipts")
    .select("po_line_id, qty_received")
    .eq("po_id", poId);
  const finalByLine = new Map<string, number>();
  for (const r of allReceipts ?? []) {
    finalByLine.set(r.po_line_id, (finalByLine.get(r.po_line_id) ?? 0) + r.qty_received);
  }
  const fullyReceived =
    (po.lines ?? []).length > 0 &&
    (po.lines ?? []).every((l) => (finalByLine.get(l.id) ?? 0) >= l.quantity);

  if (fullyReceived) {
    const admin = createAdminClient();
    const { error: upErr } = await admin
      .from("purchase_orders")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("id", poId);
    if (upErr) console.error("recordReceipt status flip failed", upErr.message);
  }

  revalidatePath("/purchase-orders");
  return { success: true, fullyReceived };
}
