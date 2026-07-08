// Pure parsers for the Cargo Partner responses (unit-testable, no network).
// The lookup endpoint returns an ARRAY of SPOT-ID strings for a reference; the
// detail endpoint returns the rich shipment object.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CargoDetail {
  container_ref?: string
  eta?: string
  shipped_at?: string
  vessel?: string
  carrier?: string
  /** Latest tracking milestone (the API derives "status" from events[]). */
  last_event?: string
  last_event_at?: string
}

/** The most recent event by timestamp (the live tracking status). */
export function pickLatestEvent(d: any): { name: string; date: string } | undefined {
  const evs: any[] = Array.isArray(d?.events) ? d.events : []
  const cleaned = evs
    .map((e) => ({ name: e?.eventTypeName ?? '', date: e?.eventTimestamp?.date ?? '', time: e?.eventTimestamp?.time ?? '' }))
    .filter((e) => e.name && e.date)
  if (!cleaned.length) return undefined
  cleaned.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  const last = cleaned[cleaned.length - 1]
  return { name: last.name, date: last.date }
}

/** Normalise the /shipments/lookup body to a clean list of SPOT IDs. */
export function parseSpotIds(body: unknown): string[] {
  if (!Array.isArray(body)) return []
  // Sort newest-first (SPOT IDs are monotonic) so that when a reference maps to
  // more than one shipment, the [0] we link is DETERMINISTIC across refreshes —
  // it won't silently swap on the API returning the array in a different order.
  return body
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

/**
 * The shipment's ETA: prefer the door delivery date, then the port-of-discharge
 * arrival. We deliberately DON'T fall back to an arbitrary last routing point —
 * that could be an intermediate transhipment and mislead.
 */
export function pickEta(d: any): string | undefined {
  const rp: any[] = d?.routingInformation?.routingPoints ?? []
  const discharge = rp.find((p) => p?.routingPointType === 'PORT_OF_DISCHARGE')
  return (
    d?.routingInformation?.delivery?.estimatedDelivery?.date ??
    discharge?.estimatedArrival?.date ??
    undefined
  )
}

/** Pull container / ETA / shipped / vessel / carrier / latest-event from a /shipments/{id} body. */
export function extractShipmentDetail(d: any): CargoDetail {
  const transport = d?.shipmentDetails?.shipmentTransportDetails
  const latest = pickLatestEvent(d)
  return {
    container_ref: d?.containerDefinition?.containers?.[0]?.containerNumber ?? undefined,
    eta: pickEta(d),
    shipped_at: d?.routingInformation?.pickup?.estimatedCargoReadiness?.date ?? undefined,
    vessel: transport?.vesselName ?? undefined,
    carrier: transport?.oceanCarrier?.name ?? undefined,
    last_event: latest?.name,
    last_event_at: latest?.date,
  }
}
