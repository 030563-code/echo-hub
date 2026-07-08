"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { getCargoToken, fetchSpotIds, fetchShipmentDetail } from "@/lib/cargo-client";

// ---------------------------------------------------------------------------
// Auto-detect a PO's Cargo Partner shipment: resolve the SPOT ID from the PO
// NUMBER (general reference), fetch the shipment detail, and PERSIST it in
// po_shipments (one row per PO, upsert) — so the SPOT ID is detected + stored
// by the system, never typed. Reads come from po_shipments on the PO board.
// Writes are service-role (RLS blocks authenticated writes); gated transport.view
// (credentialed Cargo proxy). A scheduled sweep is the planned follow-up.
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
type PoRef = { id: string; po_number: string };
type Admin = ReturnType<typeof createAdminClient>;

export type ResolveResult =
  | { success: true; found: boolean; spot_id?: string }
  | { success: false; error: string };

export type SyncResult =
  | { success: true; checked: number; resolved: number }
  | { success: false; error: string };

// Resolve one PO → SPOT ID → detail, upsert po_shipments. Returns whether a
// shipment was found. Assumes the caller already gated + holds a token. On a
// CONFIRMED no-match (fetchSpotIds throws on a 5xx outage, so reaching here with
// an empty list means the reference genuinely has no shipment) any previously
// stored link is cleared, so the panel never shows a stale shipment.
async function resolveAndStore(token: string, admin: Admin, po: PoRef): Promise<boolean> {
  const spotIds = await fetchSpotIds(token, po.po_number);
  if (!spotIds.length) {
    await admin.from("po_shipments").delete().eq("po_id", po.id);
    return false;
  }
  const detail = await fetchShipmentDetail(token, spotIds[0]);
  await admin.from("po_shipments").upsert(
    {
      po_id: po.id,
      po_number: po.po_number,
      spot_id: spotIds[0],
      match_count: spotIds.length,
      container_ref: detail.container_ref ?? null,
      eta: detail.eta ?? null,
      shipped_at: detail.shipped_at ?? null,
      vessel: detail.vessel ?? null,
      carrier: detail.carrier ?? null,
      last_event: detail.last_event ?? null,
      last_event_at: detail.last_event_at ?? null,
      resolved_at: new Date().toISOString(),
    },
    { onConflict: "po_id" }
  );
  return true;
}

/** Detect + store the shipment for one PO (the side-panel "Detect / Refresh" action). */
export async function resolvePoShipment(poId: string): Promise<ResolveResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("transport.view")) {
    return { success: false, error: "Forbidden: missing transport capability" };
  }
  if (!uuid.safeParse(poId).success) return { success: false, error: "Invalid PO id" };

  const supabase = await createServerClient();
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_number")
    .eq("id", poId)
    .maybeSingle<PoRef>();
  if (!po) return { success: false, error: "Purchase order not found" };

  try {
    const token = await getCargoToken();
    const admin = createAdminClient();
    const found = await resolveAndStore(token, admin, po);
    revalidatePath("/purchase-orders");
    if (!found) return { success: true, found: false };
    const { data: row } = await admin.from("po_shipments").select("spot_id").eq("po_id", poId).maybeSingle();
    return { success: true, found: true, spot_id: (row as { spot_id: string } | null)?.spot_id };
  } catch (e) {
    // A 404 is handled above as a clean "no shipment"; reaching here means a
    // transient 5xx / network blip — surface it as retryable, NOT "no shipment"
    // (so we never imply a PO has no shipment when Cargo was just unreachable).
    console.error("resolvePoShipment failed", (e as Error).message);
    return { success: false, error: "Couldn't reach Cargo Partner — please try again." };
  }
}

/** Sweep all active POs: resolve + store any with a Cargo shipment (one token). */
export async function syncAllPoShipments(): Promise<SyncResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("transport.view")) {
    return { success: false, error: "Forbidden: missing transport capability" };
  }

  const supabase = await createServerClient();
  const { data: pos } = await supabase
    .from("purchase_orders")
    .select("id, po_number")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(60); // cap the per-run Cargo calls; the scheduled sweep will page later
  const list = (pos ?? []) as PoRef[];
  if (!list.length) return { success: true, checked: 0, resolved: 0 };

  try {
    const token = await getCargoToken();
    const admin = createAdminClient();
    let resolved = 0;
    for (const po of list) {
      try {
        if (await resolveAndStore(token, admin, po)) resolved++;
      } catch (e) {
        console.error("syncAllPoShipments item failed", po.po_number, (e as Error).message);
      }
    }
    revalidatePath("/purchase-orders");
    return { success: true, checked: list.length, resolved };
  } catch (e) {
    console.error("syncAllPoShipments failed", (e as Error).message);
    return { success: false, error: "Cargo Partner sync failed." };
  }
}
