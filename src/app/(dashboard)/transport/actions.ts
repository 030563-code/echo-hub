"use server";

import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { hasCapability } from "@/lib/authz";
import { revalidatePath } from "next/cache";
import { getCargoToken, fetchSpotIds, fetchShipmentDetail } from "@/lib/cargo-client";

const SKU_NAMES: Record<string, string> = {
  // NA — North America-facing
  EBH9NA: "Echo Barrier H9", EBH9WNA: "Echo Barrier H9W",
  EBH9XNA: "Echo Barrier H9X", EBH9ERNA: "Echo Barrier H9 Ex Rental",
  EBH10NA: "Echo Barrier H10", EBH10HERCNA: "Echo Barrier H10 HERC",
  EBH8NA: "Echo Barrier H8", V2NA: "Echo Barrier V2",
  CCSNA: "Compact Cutting Station", FSCNA: "Full Size Cutting Station",
  BUNNA: "Bungies", HKNA: "Hooks", EBVFKNA: "Vertical Fitting Kits", M1NA: "M1 Mini Gen Set",
  // SK — SRO / Slovakia-internal
  EBH9SK: "Echo Barrier H9", EBH10SK: "Echo Barrier H10",
  EBH9WSK: "Echo Barrier H9W", EBH9X21SK: "Echo Barrier H9X 2.1W",
  EBH9X15SK: "Echo Barrier H9X 1.5W", EBH8SK: "Echo Barrier H8",
  EBHT35SK: "Echo Barrier HT3.5",
  EBH9JAPSK: "Echo Barrier H9 Japan", EBH10JAPSK: "Echo Barrier H10 Japan",
  EBH10HBSK: "Echo Barrier H10 HERC Black",
  EBH9MINISK: "Echo Barrier H9 Mini", EBH8MINISK: "Echo Barrier H8 Mini",
  HERASSK: "Noise Defender HERAS", NDS200SK: "Noise Defender NDS200", NDTSK: "Noise Defender NDT",
  CSFSSR: "Full Size Cutting Station", CSCSSR: "Compact Cutting Station",
  CSPTSK: "CS Plus Tunnel", CSPWSK: "CS Plus W",
  V2SK: "Echo Barrier V2", M1SK: "M1 Mini Gen Set", GENEXTSK: "Generator Extension Cable",
};

export interface CargoPartnerLookupResult {
  found: boolean;
  /** The Cargo Partner SPOT ID auto-retrieved from the PO / general reference. */
  spot_id?: string;
  /** How many shipments matched the reference (>1 → we returned the first). */
  match_count?: number;
  container_ref?: string;
  eta?: string;
  shipped_at?: string;
  vessel?: string;
  carrier?: string;
  error?: string;
}

/**
 * Resolve a PO / general reference → the Cargo Partner SPOT ID (+ container/ETA/
 * vessel) — eliminating manual SPOT-ID entry. Lookup returns an ARRAY of SPOT IDs;
 * we take the first and fetch its detail.
 */
export async function lookupCargoPartnerShipment(
  reference: string
): Promise<CargoPartnerLookupResult> {
  // Capability gate — this is a credentialed proxy to Cargo Partner; don't let an
  // unauthorized user enumerate shipments against Echo Barrier's account.
  if (!(await hasCapability("transport.view"))) {
    return { found: false, error: "Forbidden: missing transport capability" };
  }
  if (!reference.trim()) return { found: false };

  try {
    const token = await getCargoToken();
    const spotIds = await fetchSpotIds(token, reference);
    if (!spotIds.length) return { found: false };
    const detail = await fetchShipmentDetail(token, spotIds[0]);
    return { found: true, spot_id: spotIds[0], match_count: spotIds.length, ...detail };
  } catch {
    // 404 is returned above as a clean { found:false } (no shipment); this catch
    // is the transient-5xx / network path — retryable, not "no shipment".
    return { found: false, error: "Couldn't reach Cargo Partner — please try again." };
  }
}

const AddShipmentSchema = z.object({
  spot_id: z.string().min(1, "SPOT ID is required"),
  container_ref: z.string().optional(),
  sku: z.string().min(1, "SKU is required"),
  qty: z.number().int().min(1).max(99999),
  depot_destination: z.enum(["US-BAL", "US-SBD", "CA-HAM"]),
  status: z.enum(["on_water", "at_port", "customs", "delivered"]),
  shipped_at: z.string().optional(),
  eta: z.string().optional(),
  po_reference: z.string().optional(),
});

export type AddShipmentInput = z.infer<typeof AddShipmentSchema>;

export async function addShipment(
  input: AddShipmentInput
): Promise<{ success: true; warning?: string } | { error: string }> {
  if (!(await hasCapability('transport.view'))) {
    return { error: 'Forbidden: missing transport capability' };
  }
  const parsed = AddShipmentSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input — check all required fields" };

  const d = parsed.data;
  const supabase = await createServerClient();

  // Resolve the reference to a real PO so the shipment structurally links back to
  // its order (not just a text match). Null if it doesn't match a Hub PO#.
  let poId: string | null = null;
  let warning: string | undefined;
  const ref = d.po_reference?.trim();
  if (ref) {
    const { data: match } = await supabase.from("purchase_orders").select("id").eq("po_number", ref).maybeSingle();
    poId = (match as { id: string } | null)?.id ?? null;
    if (!poId) warning = `Reference "${ref}" doesn't match any Hub PO number — the shipment won't link to an order yet.`;
  }

  const { error } = await supabase.from("shipment_contents").insert({
    spot_id: d.spot_id,
    container_ref: d.container_ref || null,
    sku: d.sku,
    product_name: SKU_NAMES[d.sku] ?? null,
    qty: d.qty,
    depot_destination: d.depot_destination,
    status: d.status,
    shipped_at: d.shipped_at || null,
    eta: d.eta || null,
    po_reference: ref || null,
    po_id: poId,
  });

  if (error) return { error: "Failed to save shipment" };
  revalidatePath("/transport");
  return { success: true, warning };
}
