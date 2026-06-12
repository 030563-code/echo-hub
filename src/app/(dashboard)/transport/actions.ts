"use server";

import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { hasCapability } from "@/lib/authz";
import { revalidatePath } from "next/cache";

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

async function getCargoPartnerToken(): Promise<string> {
  const res = await fetch("https://auth.cargo-partner.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: process.env.CARGO_PARTNER_USERNAME!,
      password: process.env.CARGO_PARTNER_PASSWORD!,
      grant_type: "password",
      client_id: process.env.CARGO_PARTNER_CLIENT_ID!,
      client_secret: process.env.CARGO_PARTNER_CLIENT_SECRET!,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Cargo Partner auth failed");
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

export interface CargoPartnerLookupResult {
  found: boolean;
  container_ref?: string;
  eta?: string;
  shipped_at?: string;
  error?: string;
}

export async function lookupCargoPartnerShipment(
  reference: string
): Promise<CargoPartnerLookupResult> {
  // Capability gate — this is a credentialed proxy to Cargo Partner; don't let an
  // unauthorized user enumerate shipments against Echo Barrier's account.
  if (!(await hasCapability('transport.view'))) {
    return { found: false, error: 'Forbidden: missing transport capability' };
  }
  if (!reference.trim()) return { found: false };

  try {
    const token = await getCargoPartnerToken();

    const res = await fetch(
      "https://api.cargo-partner.com/transport/v1/shipments/lookup",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference: {
            referenceType: "GENERAL_REFERENCE",
            referenceNumber: reference.trim(),
          },
        }),
        cache: "no-store",
      }
    );

    if (!res.ok) return { found: false };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as Record<string, any>;

    // Extract fields from common response shapes
    const container_ref =
      data?.containers?.[0]?.containerNumber ??
      data?.containerNumber ??
      data?.container?.containerNumber ??
      undefined;

    const eta =
      data?.routing?.delivery?.estimatedDelivery?.date ??
      data?.estimatedDelivery ??
      data?.routingInformation?.delivery?.estimatedDelivery?.date ??
      undefined;

    const shipped_at =
      data?.routing?.pickup?.actualCargoReadiness?.date ??
      data?.routingInformation?.pickup?.estimatedCargoReadiness?.date ??
      undefined;

    return { found: true, container_ref, eta, shipped_at };
  } catch {
    return { found: false, error: "Lookup failed — check the reference and try again" };
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
): Promise<{ success: true } | { error: string }> {
  if (!(await hasCapability('transport.view'))) {
    return { error: 'Forbidden: missing transport capability' };
  }
  const parsed = AddShipmentSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input — check all required fields" };

  const d = parsed.data;
  const supabase = await createServerClient();

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
    po_reference: d.po_reference || null,
  });

  if (error) return { error: "Failed to save shipment" };
  revalidatePath("/shipping");
  return { success: true };
}
