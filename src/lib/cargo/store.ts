import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { sheetReferencesBySpot } from './sync'
import { cargoTimeline, cargoStatus, type CargoRoutingPoint, type CargoEventRow, type TimelineStop } from './payload'
import type { EventKind } from './event-types'

/**
 * Reading the cargo tables.
 *
 * Everything goes through the admin client on purpose. The four cargo tables
 * revoke anon and authenticated, so a session client sees nothing at all, and
 * the scope is applied here in the query rather than left to a policy. That is
 * the same contract every other module keeps: a scope that is only a check is
 * not a scope.
 */

export interface CargoBoardRow {
  spotId: string
  containerNumbers: string[]
  generalReference: string | null
  vesselName: string | null
  oceanCarrier: string | null
  originCity: string | null
  destinationCity: string | null
  destinationDepot: string | null
  cargoDescription: string | null
  totalPieces: number | null
  pickedUpOn: string | null
  departedOn: string | null
  eta: string | null
  currentStatus: string | null
  currentStatusOn: string | null
  currentStatusLocation: string | null
  isComplete: boolean
  syncedAt: string | null
  /** Days late against the forwarder's own schedule changes, summed. */
  slipDays: number | null
  /** Ours, typed on the shipment, then Dave's sheet order numbers. Searched; never on a shared page. */
  references: string[]
}

export interface ShipmentReference {
  id: string
  reference: string
  addedAt: string
}

export interface CargoShipmentView extends CargoBoardRow {
  modality: string | null
  category: string | null
  voyageNumber: string | null
  hbl: string | null
  mbl: string | null
  shipperName: string | null
  consigneeName: string | null
  originCountry: string | null
  destinationCountry: string | null
  totalWeight: number | null
  totalVolume: number | null
  goodsValue: number | null
  currencyCode: string | null
  containers: { number: string; code: string | null; seal: string | null }[]
  /** The references people typed on this shipment, which they can remove. */
  ownReferences: ShipmentReference[]
  /** Dave's sheet order numbers, read from his table. */
  sheetReferences: string[]
  route: CargoRoutingPoint[]
  events: CargoEventRow[]
  timeline: TimelineStop[]
  milestones: {
    cargoReady: string | null
    pickedUp: string | null
    loadedOnVessel: string | null
    departed: string | null
    unloaded: string | null
    arrived: string | null
    delivered: string | null
    emptyReturned: string | null
  }
}

const SHIPMENT_COLUMNS = `
  spot_id, modality, category, vessel_name, voyage_number, ocean_carrier, hbl, mbl,
  shipper_name, consignee_name, origin_city, origin_country, destination_city,
  destination_country, destination_depot, total_pieces, total_weight, total_volume,
  goods_value, currency_code, cargo_description, general_reference,
  cargo_ready_on, picked_up_on, loaded_on_vessel_on, departed_on, unloaded_on,
  arrived_on, delivered_on, empty_returned_on, eta, current_status, current_status_on,
  current_status_location, is_complete, synced_at
`

/* eslint-disable @typescript-eslint/no-explicit-any */

function toBoardRow(s: any, containers: string[], slipDays: number | null, references: string[] = []): CargoBoardRow {
  return {
    spotId: s.spot_id,
    containerNumbers: containers,
    generalReference: s.general_reference ?? null,
    vesselName: s.vessel_name ?? null,
    oceanCarrier: s.ocean_carrier ?? null,
    originCity: s.origin_city ?? null,
    destinationCity: s.destination_city ?? null,
    destinationDepot: s.destination_depot ?? null,
    cargoDescription: s.cargo_description ?? null,
    totalPieces: s.total_pieces ?? null,
    pickedUpOn: s.picked_up_on ?? null,
    departedOn: s.departed_on ?? null,
    eta: s.eta ?? null,
    currentStatus: s.current_status ?? null,
    currentStatusOn: s.current_status_on ?? null,
    currentStatusLocation: s.current_status_location ?? null,
    isComplete: Boolean(s.is_complete),
    syncedAt: s.synced_at ?? null,
    slipDays,
    references,
  }
}

/** Our references first, then the sheet's, each once. */
function mergeReferences(own: readonly string[], sheet: readonly string[]): string[] {
  const all: string[] = []
  for (const r of [...own, ...sheet]) if (!all.includes(r)) all.push(r)
  return all
}

/**
 * The board.
 *
 * `depots` scopes it: a depot's organisation sees what is bound for its depots,
 * and s.r.o. and Group see everything because every container leaves s.r.o. and
 * belongs to Group on the way. Pass null to mean "all of them".
 *
 * 🔴 A shipment whose destination_depot we could not work out is shown to the
 * see-everything organisations and to nobody else. Hiding it from everyone would
 * make a container in the Atlantic disappear from the Hub because a city name
 * did not match a lookup.
 */
export async function loadCargoBoard(depots: readonly string[] | null): Promise<CargoBoardRow[]> {
  const admin = createAdminClient()

  let query = admin.from('cargo_shipment').select(SHIPMENT_COLUMNS)
  if (depots) query = query.in('destination_depot', [...depots])
  const { data: shipments } = await query.order('eta', { ascending: true, nullsFirst: false })

  const rows = (shipments ?? []) as any[]
  if (!rows.length) return []
  const ids = rows.map((r) => r.spot_id)

  const [{ data: containers }, { data: slips }, { data: ownRefs }, sheet] = await Promise.all([
    admin.from('cargo_container').select('spot_id, container_number, container_index').in('spot_id', ids),
    admin.from('cargo_event').select('spot_id, delay_days, delay_seconds').in('spot_id', ids).eq('event_kind', 'exception'),
    admin.from('cargo_shipment_reference').select('spot_id, reference, added_at').in('spot_id', ids).order('added_at'),
    sheetReferencesBySpot(ids),
  ])
  const ownBy = new Map<string, string[]>()
  for (const r of (ownRefs ?? []) as { spot_id: string; reference: string }[]) {
    ownBy.set(r.spot_id, [...(ownBy.get(r.spot_id) ?? []), r.reference])
  }

  const byShipment = new Map<string, string[]>()
  for (const c of ((containers ?? []) as any[]).sort((a, b) => a.container_index - b.container_index)) {
    const list = byShipment.get(c.spot_id) ?? []
    list.push(c.container_number)
    byShipment.set(c.spot_id, list)
  }

  // Every schedule change the forwarder raised, added up. Seconds where we have
  // them, because the wording rounds down.
  const slipBy = new Map<string, number>()
  for (const e of (slips ?? []) as any[]) {
    const days = e.delay_seconds != null ? e.delay_seconds / 86_400 : e.delay_days
    if (days == null) continue
    slipBy.set(e.spot_id, (slipBy.get(e.spot_id) ?? 0) + Number(days))
  }

  return rows.map((s) =>
    toBoardRow(
      s,
      byShipment.get(s.spot_id) ?? [],
      slipBy.has(s.spot_id) ? Math.round(slipBy.get(s.spot_id)!) : null,
      mergeReferences(ownBy.get(s.spot_id) ?? [], sheet.get(s.spot_id) ?? []),
    ),
  )
}

/** One shipment, whole, with its route and its timeline already built. */
export async function loadCargoShipment(spotId: string, today: string): Promise<CargoShipmentView | null> {
  const admin = createAdminClient()

  const { data: s } = await admin.from('cargo_shipment').select(SHIPMENT_COLUMNS).eq('spot_id', spotId).maybeSingle()
  if (!s) return null

  const [{ data: containers }, { data: points }, { data: events }, { data: ownRefs }, sheet] = await Promise.all([
    admin.from('cargo_container').select('*').eq('spot_id', spotId).order('container_index'),
    admin.from('cargo_routing_point').select('*').eq('spot_id', spotId).order('seq'),
    admin
      .from('cargo_event')
      .select('*')
      .eq('spot_id', spotId)
      .order('event_on', { ascending: true })
      .order('event_time', { ascending: true }),
    admin.from('cargo_shipment_reference').select('id, reference, added_at').eq('spot_id', spotId).order('added_at'),
    sheetReferencesBySpot([spotId]),
  ])
  const ownReferences: ShipmentReference[] = ((ownRefs ?? []) as any[]).map((r) => ({
    id: r.id,
    reference: r.reference,
    addedAt: r.added_at,
  }))
  const sheetReferences = sheet.get(spotId) ?? []

  const route: CargoRoutingPoint[] = ((points ?? []) as any[]).map((p) => ({
    seq: p.seq,
    type: p.point_type,
    unlocode: p.unlocode,
    countryCode: p.country_code,
    city: p.city,
    legModality: p.leg_modality,
    estimatedDeparture: p.estimated_departure,
    realDeparture: p.real_departure,
    estimatedArrival: p.estimated_arrival,
    realArrival: p.real_arrival,
  }))

  const eventRows: CargoEventRow[] = ((events ?? []) as any[]).map((e) => ({
    identifier: e.event_identifier,
    name: e.event_name,
    kind: e.event_kind as EventKind,
    date: e.event_on,
    time: e.event_time ?? '',
    locationCode: e.location_code,
    locationName: e.location_name,
    containerNumber: e.container_number,
    remark: e.remark,
    delayDays: e.delay_days,
    delaySeconds: e.delay_seconds,
  }))

  const slip = eventRows
    .filter((e) => e.kind === 'exception')
    .reduce<number | null>((sum, e) => {
      const days = e.delaySeconds != null ? e.delaySeconds / 86_400 : e.delayDays
      return days == null ? sum : (sum ?? 0) + days
    }, null)

  const anyShipment = s as any
  return {
    ...toBoardRow(
      anyShipment,
      ((containers ?? []) as any[]).map((c) => c.container_number),
      slip == null ? null : Math.round(slip),
      mergeReferences(ownReferences.map((r) => r.reference), sheetReferences),
    ),
    ownReferences,
    sheetReferences,
    modality: anyShipment.modality,
    category: anyShipment.category,
    voyageNumber: anyShipment.voyage_number,
    hbl: anyShipment.hbl,
    mbl: anyShipment.mbl,
    shipperName: anyShipment.shipper_name,
    consigneeName: anyShipment.consignee_name,
    originCountry: anyShipment.origin_country,
    destinationCountry: anyShipment.destination_country,
    totalWeight: anyShipment.total_weight,
    totalVolume: anyShipment.total_volume,
    goodsValue: anyShipment.goods_value,
    currencyCode: anyShipment.currency_code,
    containers: ((containers ?? []) as any[]).map((c) => ({
      number: c.container_number,
      code: c.container_code,
      seal: c.seal_number,
    })),
    route,
    events: eventRows,
    timeline: cargoTimeline(route, eventRows, today),
    milestones: {
      cargoReady: anyShipment.cargo_ready_on,
      pickedUp: anyShipment.picked_up_on,
      loadedOnVessel: anyShipment.loaded_on_vessel_on,
      departed: anyShipment.departed_on,
      unloaded: anyShipment.unloaded_on,
      arrived: anyShipment.arrived_on,
      delivered: anyShipment.delivered_on,
      emptyReturned: anyShipment.empty_returned_on,
    },
  }
}

/**
 * What a customer is allowed to see.
 *
 * 🔴 Everything commercial comes off: the goods value, the currency, the weight
 * and volume we declared, the shipper and consignee legal names, the bills of
 * lading and the internal references. What is left is where their goods are and
 * when they are expected, which is the whole reason to send somebody a link.
 *
 * This is a whitelist and not a delete list on purpose. A field added to
 * CargoShipmentView later is invisible to a customer until somebody decides it
 * should not be, which is the right way round.
 */
export interface CargoPublicView {
  reference: string | null
  containerNumbers: string[]
  vesselName: string | null
  oceanCarrier: string | null
  originCity: string | null
  destinationCity: string | null
  cargoDescription: string | null
  eta: string | null
  currentStatus: string | null
  currentStatusOn: string | null
  currentStatusLocation: string | null
  isComplete: boolean
  timeline: TimelineStop[]
  syncedAt: string | null
}

export function toPublicView(v: CargoShipmentView, today: string): CargoPublicView {
  // A customer is told where their container is, not what happened in an office.
  // "Pre-alert processed at Bratislava" is true and means nothing to them. A
  // physical milestone that happened LATER always wins, so this never shows an
  // older position than the internal page does.
  const physical = cargoStatus(v.events, today, { physicalOnly: true })
  return {
    reference: v.generalReference,
    containerNumbers: v.containerNumbers,
    vesselName: v.vesselName,
    oceanCarrier: v.oceanCarrier,
    originCity: v.originCity,
    destinationCity: v.destinationCity,
    cargoDescription: v.cargoDescription,
    eta: v.eta,
    currentStatus: physical?.name ?? v.currentStatus,
    currentStatusOn: physical?.date ?? v.currentStatusOn,
    currentStatusLocation: physical?.location ?? v.currentStatusLocation,
    isComplete: v.isComplete,
    timeline: v.timeline,
    syncedAt: v.syncedAt,
  }
}
