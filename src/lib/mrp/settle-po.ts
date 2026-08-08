import type { SupabaseClient } from "@supabase/supabase-js";
import { transitDays } from "./receipts";

// ---------------------------------------------------------------------------
// Settlement of a fully-received PO (extracted from recordReceipt so the flip
// and its side effects live in one auditable place).
//
// SINGLE-WINNER contract: the status flip is a conditional update
// (`status <> 'delivered'`) and only the caller whose update actually changed
// a row runs the side effects (in-transit drain + lead-time actuals). Two
// concurrent final batches previously both observed status='approved',
// both flipped, and both inserted duplicate 'door' lead-time actuals — under
// READ COMMITTED the second update now blocks on the winner's row lock,
// re-evaluates its predicate after commit, matches zero rows, and skips.
// ---------------------------------------------------------------------------

export interface InTransitShipmentRow {
  id: string;
  spot_id: string | null;
  shipped_at: string | null;
}

export interface DoorLeadTimeActual {
  po_id: string;
  spot_id: string | null;
  leg: "door";
  days: number;
}

/**
 * Pure: fully-received PO's still-in-transit shipment rows → 'door' lead-time
 * observations (shipped_at → settlement time, fractional days). Rows without
 * a usable shipped_at, or with an implausible span, yield nothing — the
 * plausibility rules live in transitDays.
 */
export function buildDoorLeadTimeActuals(
  poId: string,
  rows: InTransitShipmentRow[],
  nowIso: string
): DoorLeadTimeActual[] {
  const actuals: DoorLeadTimeActual[] = [];
  for (const s of rows) {
    const days = transitDays(s.shipped_at, nowIso);
    if (days !== null) actuals.push({ po_id: poId, spot_id: s.spot_id, leg: "door", days });
  }
  return actuals;
}

/**
 * Flip a fully-received PO to 'delivered' and, ONLY when this caller won the
 * flip, drain its linked in-transit shipment rows and record door lead-time
 * actuals. Side effects are best-effort (logged, never thrown) — the receipt
 * rows that triggered settlement are already committed.
 *
 * Returns { won } so callers can distinguish "I settled it" from "someone
 * already had" (both are success paths for recordReceipt).
 */
export async function settleDeliveredPO(
  admin: SupabaseClient,
  poId: string,
  nowIso: string
): Promise<{ won: boolean }> {
  // Single-winner status flip: only the update that transitions the row away
  // from a non-delivered status returns it. `.select('id')` makes the affected
  // row(s) observable — zero rows back means another batch already settled.
  const { data: flipped, error: upErr } = await admin
    .from("purchase_orders")
    .update({ status: "delivered", delivered_at: nowIso })
    .eq("id", poId)
    .neq("status", "delivered")
    .select("id");
  if (upErr) {
    console.error("settleDeliveredPO status flip failed", upErr.message);
    return { won: false };
  }
  if (!flipped || flipped.length === 0) return { won: false };

  // Winner-only side effects. The PO is fully received, so any shipment rows
  // still marked in-transit for it have physically landed — drain them to
  // 'delivered' and capture the real door lead time (shipped_at → now) per row.
  const { data: inTransit, error: shipErr } = await admin
    .from("shipment_contents")
    .select("id, spot_id, shipped_at")
    .eq("po_id", poId)
    .neq("status", "delivered");
  if (shipErr) console.error("settleDeliveredPO in-transit lookup failed", shipErr.message);

  if (inTransit && inTransit.length > 0) {
    const { error: drainErr } = await admin
      .from("shipment_contents")
      .update({ status: "delivered", delivered_at: nowIso })
      .in(
        "id",
        inTransit.map((s) => s.id)
      );
    if (drainErr) console.error("settleDeliveredPO in-transit drain failed", drainErr.message);

    const actuals = buildDoorLeadTimeActuals(poId, inTransit, nowIso);
    if (actuals.length > 0) {
      const { error: ltErr } = await admin.from("mrp_lead_time_actuals").insert(actuals);
      if (ltErr) console.error("settleDeliveredPO lead-time actuals insert failed", ltErr.message);
    }
  }

  return { won: true };
}
