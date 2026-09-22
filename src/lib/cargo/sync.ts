import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@supabase/supabase-js'
import { getCargoToken } from '@/lib/cargo-client'
import { externalCallsDisabled } from '@/lib/env'
import {
  parseCargoPayload,
  cargoMilestones,
  cargoStatus,
  cargoEta,
  cargoComplete,
  type ParsedCargo,
} from './payload'

/**
 * Pull the Cargo Partner shipments the Hub knows about and keep our own copy.
 *
 * READ ONLY against the forwarder, like everything else that talks to them.
 * There is no create, no update and no event POST anywhere in the Hub: a
 * transport order is a real booking and Dean flips that switch, not the code.
 *
 * WHERE THE SPOT IDS COME FROM. Two places, unioned, and neither is a new
 * integration:
 *   eb_operations.shipments  Dave's n8n WF2 reads the three "Spot ID" tabs of the
 *                            Container Shipment sheet every morning at 06:15 and
 *                            lands them here. We read that table and never write
 *                            it: three depot emails to outside forwarders depend
 *                            on it, and two writers on one table is how they
 *                            come to disagree.
 *   public.po_shipments      what the Hub resolved itself from a PO reference.
 *
 * So the Google Sheet stays where it is and keeps its one owner. The Hub takes
 * the identifiers it already produces and goes and gets the detail.
 */

export interface CargoSyncResult {
  attempted: number
  synced: number
  failed: { spotId: string; error: string }[]
}

/** A client bound to the schema Dave's workflow writes. Reads only. */
function createOperationsClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'eb_operations' },
  })
}

/** Cargo Partner delivers to a city; we think in depot codes. */
const CITY_TO_DEPOT: Record<string, string> = {
  jessup: 'US-BAL',
  baltimore: 'US-BAL',
  'rancho cucamonga': 'US-SBD',
  'san bernardino': 'US-SBD',
  hamilton: 'CA-HAM',
}

export function depotForCity(city: string | null | undefined): string | null {
  return CITY_TO_DEPOT[(city ?? '').trim().toLowerCase()] ?? null
}

/**
 * Every SPOT ID worth asking about, with the depot we already believe it is for.
 *
 * A shipment appears once per barrier type in eb_operations.shipments, so the
 * same SPOT ID comes back several times; they collapse here.
 */
export async function knownSpotIds(): Promise<{ spotId: string; depot: string | null }[]> {
  const found = new Map<string, string | null>()

  try {
    const ops = createOperationsClient()
    const { data } = await ops.from('shipments').select('spot_id, destination_depot')
    for (const row of (data ?? []) as { spot_id: string | null; destination_depot: string | null }[]) {
      const id = String(row.spot_id ?? '').trim()
      if (!id) continue
      // Keep the first depot we see, but let a named one beat a null.
      if (!found.has(id) || (found.get(id) == null && row.destination_depot)) {
        found.set(id, row.destination_depot ?? null)
      }
    }
  } catch {
    // The operations schema is somebody else's. If it is unreachable the Hub
    // still syncs whatever it resolved itself rather than failing the run.
  }

  const admin = createAdminClient()
  const { data: po } = await admin.from('po_shipments').select('spot_id').not('spot_id', 'is', null)
  for (const row of (po ?? []) as { spot_id: string | null }[]) {
    const id = String(row.spot_id ?? '').trim()
    if (id && !found.has(id)) found.set(id, null)
  }

  return [...found.entries()]
    .map(([spotId, depot]) => ({ spotId, depot }))
    .sort((a, b) => b.spotId.localeCompare(a.spotId, undefined, { numeric: true }))
}

/** The whole response, unparsed. The stored copy is the raw one. */
async function fetchRawShipment(token: string, spotId: string): Promise<unknown | null> {
  const res = await fetch(
    `https://api.cargo-partner.com/transport/v1/shipments/${encodeURIComponent(spotId)}`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, cache: 'no-store' },
  )
  // A 404 means the identifier is wrong, which happens: one row in the shipping
  // sheet carries an eight digit SPOT ID where every other is nine.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Cargo Partner returned ${res.status} for ${spotId}`)
  return res.json()
}

/**
 * Write one shipment and everything under it.
 *
 * Containers, routing points and events are REPLACED rather than merged. We
 * always hold the whole response, so a merge could only ever leave behind a row
 * the forwarder has since removed. Deleting first also sidesteps the fact that
 * events have no natural key: a two container shipment raises the same milestone
 * at the same second twice, once per container and once as a roll-up.
 */
export async function storeCargoShipment(
  parsed: ParsedCargo,
  raw: unknown,
  depot: string | null,
  today: string,
): Promise<void> {
  const admin = createAdminClient()
  const { header, containers, route, events } = parsed
  const milestones = cargoMilestones(events)
  const status = cargoStatus(events, today)

  const { error: headerError } = await admin.from('cargo_shipment').upsert(
    {
      spot_id: header.spotId,
      modality: header.modality,
      category: header.category,
      vessel_name: header.vesselName,
      voyage_number: header.voyageNumber,
      ocean_carrier: header.oceanCarrier,
      hbl: header.hbl,
      mbl: header.mbl,
      shipper_name: header.shipperName,
      consignee_name: header.consigneeName,
      origin_city: header.originCity,
      origin_country: header.originCountry,
      destination_city: header.destinationCity,
      destination_country: header.destinationCountry,
      destination_depot: depot ?? depotForCity(header.destinationCity),
      total_pieces: header.totalPieces,
      total_weight: header.totalWeight,
      total_volume: header.totalVolume,
      goods_value: header.goodsValue,
      currency_code: header.currencyCode,
      cargo_description: header.cargoDescription,
      general_reference: header.generalReference,
      references_json: header.references,
      cargo_ready_on: milestones.cargoReady,
      picked_up_on: milestones.pickedUp,
      loaded_on_vessel_on: milestones.loadedOnVessel,
      departed_on: milestones.departed,
      unloaded_on: milestones.unloaded,
      arrived_on: milestones.arrived,
      delivered_on: milestones.delivered,
      empty_returned_on: milestones.emptyReturned,
      eta: cargoEta(route),
      current_status: status?.name ?? null,
      current_status_on: status?.date ?? null,
      current_status_location: status?.location ?? null,
      is_complete: cargoComplete(events),
      raw: raw as Record<string, unknown>,
      synced_at: new Date().toISOString(),
    },
    { onConflict: 'spot_id' },
  )
  if (headerError) throw new Error(`cargo_shipment upsert failed for ${header.spotId}: ${headerError.message}`)

  await Promise.all([
    admin.from('cargo_container').delete().eq('spot_id', header.spotId),
    admin.from('cargo_routing_point').delete().eq('spot_id', header.spotId),
    admin.from('cargo_event').delete().eq('spot_id', header.spotId),
  ])

  if (containers.length) {
    await admin.from('cargo_container').insert(
      containers.map((c) => ({
        spot_id: header.spotId,
        container_index: c.index,
        container_number: c.number,
        container_code: c.code,
        seal_number: c.seal,
      })),
    )
  }

  if (route.length) {
    await admin.from('cargo_routing_point').insert(
      route.map((p) => ({
        spot_id: header.spotId,
        seq: p.seq,
        point_type: p.type,
        unlocode: p.unlocode,
        country_code: p.countryCode,
        city: p.city,
        leg_modality: p.legModality,
        estimated_departure: p.estimatedDeparture,
        real_departure: p.realDeparture,
        estimated_arrival: p.estimatedArrival,
        real_arrival: p.realArrival,
      })),
    )
  }

  if (events.length) {
    await admin.from('cargo_event').insert(
      events.map((e) => ({
        spot_id: header.spotId,
        event_identifier: e.identifier,
        event_name: e.name,
        event_kind: e.kind,
        event_on: e.date,
        event_time: e.time,
        location_code: e.locationCode,
        location_name: e.locationName,
        container_number: e.containerNumber,
        remark: e.remark,
        delay_days: e.delayDays,
        delay_seconds: e.delaySeconds,
      })),
    )
  }
}

/**
 * Sync every known shipment. One token for the whole batch, and one shipment
 * failing does not stop the rest: a board that is mostly right today beats a
 * board that is entirely absent because one identifier was mistyped.
 */
export async function syncAllCargo(options?: { spotIds?: string[]; today?: string }): Promise<CargoSyncResult> {
  if (externalCallsDisabled()) {
    return { attempted: 0, synced: 0, failed: [{ spotId: '-', error: 'Cargo Partner is disabled in the staging sandbox' }] }
  }

  const all = await knownSpotIds()
  const wanted = options?.spotIds?.length
    ? all.filter((s) => options.spotIds!.includes(s.spotId))
    : all
  const today = options?.today ?? new Date().toISOString().slice(0, 10)

  const token = await getCargoToken()
  const failed: { spotId: string; error: string }[] = []
  let synced = 0

  for (const { spotId, depot } of wanted) {
    try {
      const raw = await fetchRawShipment(token, spotId)
      if (!raw) {
        failed.push({ spotId, error: 'No such shipment at Cargo Partner (404)' })
        continue
      }
      await storeCargoShipment(parseCargoPayload(raw, spotId), raw, depot, today)
      synced++
    } catch (e) {
      failed.push({ spotId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { attempted: wanted.length, synced, failed }
}
