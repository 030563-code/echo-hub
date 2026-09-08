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

export interface CargoEvent {
  name: string
  date: string
  /** '' when the API gave a date but no time. Kept so sorting stays stable. */
  time: string
  location?: string
}

/**
 * The whole tracking timeline, oldest first.
 *
 * pickLatestEvent used to do this inline and throw the rest away, which was
 * right while the board only showed a status. The shipment panel wants the
 * milestones themselves, and parsing them twice in two places is how the two
 * would end up disagreeing.
 */
export function parseEvents(d: any): CargoEvent[] {
  const evs: any[] = Array.isArray(d?.events) ? d.events : []
  return evs
    .map((e) => ({
      name: String(e?.eventTypeName ?? ''),
      date: String(e?.eventTimestamp?.date ?? ''),
      time: String(e?.eventTimestamp?.time ?? ''),
      location: e?.location?.name ? String(e.location.name) : undefined,
    }))
    .filter((e) => e.name && e.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
}

/** The most recent event by timestamp (the live tracking status). */
export function pickLatestEvent(d: any): { name: string; date: string } | undefined {
  const events = parseEvents(d)
  if (!events.length) return undefined
  const last = events[events.length - 1]
  return { name: last.name, date: last.date }
}

/** Route, oldest first, for the panel's "where has it been" line. */
export interface RoutingPoint {
  type: string
  name?: string
  estimatedArrival?: string
}

export function parseRoutingPoints(d: any): RoutingPoint[] {
  const rp: any[] = d?.routingInformation?.routingPoints ?? []
  return rp
    .map((p) => ({
      type: String(p?.routingPointType ?? ''),
      name: p?.location?.name ? String(p.location.name) : undefined,
      estimatedArrival: p?.estimatedArrival?.date ? String(p.estimatedArrival.date) : undefined,
    }))
    .filter((p) => p.type)
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
