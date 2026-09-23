/**
 * The Cargo Partner shipment payload, turned into things the Hub can store and
 * draw. Pure: no network, no database, no server-only import, so the same code
 * runs in the sync, in a test and in the browser.
 *
 * Written against 25 real payloads pulled on 22 Sep 2026, which is every SPOT ID
 * the Hub and the North America shipping sheet between them know about.
 *
 * 🔴 The shape is not fixed and must not be assumed. Those 25 shipments carry
 * between 2 and 6 routing points. One runs Presov to Bremerhaven to Montreal to
 * Hamilton; another is a single sea leg. So the timeline is built FROM the route
 * the API returns, never from a template of four stops, and a shipment that
 * grows a transhipment simply grows a stop.
 */

import {
  eventKind,
  eventLabel,
  delayDaysFromRemark,
  isPhysicalMilestone,
  MILESTONE_IDS,
  type EventKind,
} from './event-types'
import { placeName, tidyCity, legMode, type LegMode } from './places'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// What we keep
// ---------------------------------------------------------------------------

export interface CargoContainer {
  index: number
  number: string
  code: string | null
  seal: string | null
}

export interface CargoRoutingPoint {
  seq: number
  type: string
  unlocode: string | null
  countryCode: string | null
  city: string | null
  legModality: string | null
  estimatedDeparture: string | null
  realDeparture: string | null
  estimatedArrival: string | null
  realArrival: string | null
}

export interface CargoEventRow {
  identifier: string
  name: string
  kind: EventKind
  /** ISO date, always present: an event without one is dropped. */
  date: string
  /** '' when the API gave a date and no time, so sorting stays stable. */
  time: string
  locationCode: string | null
  locationName: string | null
  containerNumber: string | null
  remark: string | null
  /** Signed days of slip as the forwarder words it, for an exception that names one. */
  delayDays: number | null
  /** The same slip in seconds, which is exact where the wording is rounded down. */
  delaySeconds: number | null
}

export interface CargoShipmentHeader {
  spotId: string
  modality: string | null
  category: string | null
  vesselName: string | null
  voyageNumber: string | null
  oceanCarrier: string | null
  hbl: string | null
  mbl: string | null
  shipperName: string | null
  consigneeName: string | null
  originCity: string | null
  originCountry: string | null
  destinationCity: string | null
  destinationCountry: string | null
  totalPieces: number | null
  totalWeight: number | null
  totalVolume: number | null
  goodsValue: number | null
  currencyCode: string | null
  cargoDescription: string | null
  /** Every reference the forwarder holds, GENERAL_REFERENCE first. */
  references: { type: string; number: string }[]
  /** The customer's own order number, which is what a person searches by. */
  generalReference: string | null
}

export interface ParsedCargo {
  header: CargoShipmentHeader
  containers: CargoContainer[]
  route: CargoRoutingPoint[]
  events: CargoEventRow[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
  return s === '' ? null : s
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * An eventLocation comes in three shapes and the key names differ in each.
 *
 *   UNLOCODE  unlocodeLocation.unlocode, e.g. DEBRV
 *   ADDRESS   addressLocation.{city, countryCode, street, postCode}
 *   FREE      freeLocation.name, which is literally "no location" or "unknown"
 *             on every occurrence seen, so it is worth nothing
 *
 * It is also sometimes the empty object. Reading only the first shape loses the
 * pickup and handling milestones, which are exactly the ones that say where a
 * container is before it reaches a port.
 */
function eventLocationOf(e: any): { code: string | null; name: string | null } {
  const loc = e?.eventLocation
  const code = str(loc?.unlocodeLocation?.unlocode)
  if (code) return { code, name: placeName(code) }

  const city = tidyCity(str(loc?.addressLocation?.city))
  if (city) return { code: null, name: city }
  const country = str(loc?.addressLocation?.countryCode)
  if (country) return { code: null, name: country }

  const free = str(loc?.freeLocation?.name)
  if (!free || /^(no location|unknown)$/i.test(free)) return { code: null, name: null }
  return { code: null, name: free }
}

/**
 * The precise slip, in seconds, off an exception's additionalAttributes.
 *
 * Worth reading because the remark TRUNCATES: 676800 seconds is 7.8 days and the
 * remark beside it says "7 day(s)". A model fed the text would be told a
 * week-long slip was a day shorter than it was.
 */
function delaySecondsOf(e: any): number | null {
  const raw = e?.additionalAttributes?.[0]?.value
  const n = Number(str(raw))
  return Number.isFinite(n) && n !== 0 ? n : null
}

export function parseCargoEvents(raw: any): CargoEventRow[] {
  const list: any[] = Array.isArray(raw?.events) ? raw.events : []
  return list
    .map((e) => {
      const identifier = str(e?.eventTypeIdenfitifer) ?? ''
      const date = str(e?.eventTimestamp?.date) ?? ''
      const { code, name } = eventLocationOf(e)
      const remark = str(e?.remark)
      return {
        identifier,
        name: eventLabel(identifier, str(e?.eventTypeName) ?? ''),
        kind: eventKind(identifier),
        date,
        time: str(e?.eventTimestamp?.time) ?? '',
        locationCode: code,
        locationName: name,
        containerNumber: str(e?.containerNumber),
        remark,
        delayDays: delayDaysFromRemark(remark),
        delaySeconds: delaySecondsOf(e),
      }
    })
    .filter((e) => e.identifier && e.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .filter(dedupe())
}

/**
 * Drop an event that is byte for byte another event.
 *
 * Cargo Partner raises a milestone once per container and again as a roll-up,
 * and sometimes simply repeats itself: 22 of the 739 events across the 25
 * payloads read on 22 Sep 2026 are exact duplicates of another in the same
 * shipment. A repeat carries no information, and counting it twice would skew
 * every average the lead-time model is built on. Events that differ by their
 * container number are NOT duplicates and are all kept.
 */
function dedupe() {
  const seen = new Set<string>()
  return (e: CargoEventRow) => {
    const key = [e.identifier, e.date, e.time, e.locationCode, e.locationName, e.containerNumber, e.remark].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

export function parseCargoRoute(raw: any): CargoRoutingPoint[] {
  const points: CargoRoutingPoint[] = []
  const pickup = raw?.routingInformation?.pickup
  if (pickup) {
    points.push({
      seq: 0,
      type: 'PICKUP',
      unlocode: null,
      countryCode: str(pickup.countryCode),
      city: tidyCity(str(pickup.city)),
      legModality: null,
      estimatedDeparture: str(pickup?.estimatedCargoReadiness?.date),
      realDeparture: null,
      estimatedArrival: null,
      realArrival: null,
    })
  }
  const mid: any[] = Array.isArray(raw?.routingInformation?.routingPoints)
    ? raw.routingInformation.routingPoints
    : []
  for (const p of mid) {
    const type = str(p?.routingPointType)
    if (!type) continue
    points.push({
      seq: points.length,
      type,
      unlocode: str(p?.unlocode),
      countryCode: str(p?.countryCode),
      city: null,
      legModality: str(p?.legModality),
      estimatedDeparture: str(p?.estimatedDeparture?.date),
      realDeparture: str(p?.realDeparture?.date),
      estimatedArrival: str(p?.estimatedArrival?.date),
      realArrival: str(p?.realArrival?.date),
    })
  }
  const delivery = raw?.routingInformation?.delivery
  if (delivery) {
    points.push({
      seq: points.length,
      type: 'DELIVERY',
      unlocode: null,
      countryCode: str(delivery.countryCode),
      city: tidyCity(str(delivery.city)),
      legModality: null,
      estimatedDeparture: null,
      realDeparture: null,
      estimatedArrival: str(delivery?.estimatedDelivery?.date),
      // Rare but real: one shipment in the 25 carried a realDelivery, and a door
      // date we actually have beats one we are guessing at.
      realArrival: str(delivery?.realDelivery?.date),
    })
  }
  return points
}

export function parseCargoContainers(raw: any): CargoContainer[] {
  const list: any[] = Array.isArray(raw?.containerDefinition?.containers)
    ? raw.containerDefinition.containers
    : []
  return list
    .map((c, i) => ({
      index: num(c?.containerIndex) ?? i,
      number: str(c?.containerNumber) ?? '',
      code: str(c?.containerCode),
      seal: str(c?.sealNumber),
    }))
    .filter((c) => c.number)
    .sort((a, b) => a.index - b.index)
}

export function parseCargoHeader(raw: any, spotId: string): CargoShipmentHeader {
  const transport = raw?.shipmentDetails?.shipmentTransportDetails
  const cd = raw?.containerDefinition
  const refsRaw: any[] = Array.isArray(raw?.shipmentDetails?.references)
    ? raw.shipmentDetails.references
    : []
  const references = refsRaw
    .map((r) => ({ type: str(r?.referenceType) ?? '', number: str(r?.referenceNumber) ?? '' }))
    .filter((r) => r.type && r.number)
    .sort((a, b) => Number(b.type === 'GENERAL_REFERENCE') - Number(a.type === 'GENERAL_REFERENCE'))
  return {
    spotId,
    modality: str(raw?.mainModality),
    category: str(raw?.mainCategory),
    vesselName: str(transport?.vesselName),
    voyageNumber: str(transport?.voyageNumber),
    oceanCarrier: str(transport?.oceanCarrier?.name),
    hbl: str(transport?.hbl),
    mbl: str(transport?.mbl),
    shipperName: str(raw?.participants?.shipper?.name),
    consigneeName: str(raw?.participants?.consignee?.name),
    originCity: tidyCity(str(raw?.routingInformation?.pickup?.city)),
    originCountry: str(raw?.routingInformation?.pickup?.countryCode),
    destinationCity: tidyCity(str(raw?.routingInformation?.delivery?.city)),
    destinationCountry: str(raw?.routingInformation?.delivery?.countryCode),
    totalPieces: num(cd?.totalPieces),
    totalWeight: num(cd?.totalWeight),
    totalVolume: num(cd?.totalVolume),
    goodsValue: num(cd?.goodsValue),
    currencyCode: str(cd?.currencyCode),
    cargoDescription: str(cd?.generalCargoDescription),
    references,
    generalReference: references.find((r) => r.type === 'GENERAL_REFERENCE')?.number ?? null,
  }
}

export function parseCargoPayload(raw: any, spotId?: string): ParsedCargo {
  const id = str(spotId) ?? str(raw?.trackingId) ?? ''
  return {
    header: parseCargoHeader(raw, id),
    containers: parseCargoContainers(raw),
    route: parseCargoRoute(raw),
    events: parseCargoEvents(raw),
  }
}

// ---------------------------------------------------------------------------
// The milestones, which is what a lead time is measured between
// ---------------------------------------------------------------------------

export interface CargoMilestones {
  cargoReady: string | null
  pickedUp: string | null
  loadedOnVessel: string | null
  departed: string | null
  unloaded: string | null
  arrived: string | null
  delivered: string | null
  emptyReturned: string | null
}

/**
 * The FIRST occurrence of each milestone, not the last.
 *
 * A shipment with two containers raises "Loaded on vessel" once per container,
 * and a rescheduled sailing can raise it again days later. The question a lead
 * time asks is when the leg began, so the earliest stamp is the honest one.
 */
export function cargoMilestones(events: CargoEventRow[]): CargoMilestones {
  const first = (id: string) =>
    events.filter((e) => e.identifier === id && e.kind === 'actual').map((e) => e.date).sort()[0] ?? null
  return {
    cargoReady: events.filter((e) => e.identifier === MILESTONE_IDS.cargoReady).map((e) => e.date).sort()[0] ?? null,
    pickedUp: first(MILESTONE_IDS.pickedUp),
    loadedOnVessel: first(MILESTONE_IDS.loadedOnVessel),
    departed: first(MILESTONE_IDS.departed),
    unloaded: first(MILESTONE_IDS.unloaded),
    arrived: first(MILESTONE_IDS.arrived),
    delivered: first(MILESTONE_IDS.delivered),
    emptyReturned: first(MILESTONE_IDS.emptyReturned),
  }
}

/** Whole days between two ISO dates, or null if either is missing. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const a = Date.parse(from + 'T00:00:00Z')
  const b = Date.parse(to + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Where is it now
// ---------------------------------------------------------------------------

export interface CargoStatus {
  /** The wording to show, e.g. "Picked up". */
  name: string
  date: string
  location: string | null
  /** Every actual milestone sharing that latest timestamp, newest first. */
  alsoNames: string[]
}

/**
 * The latest thing that has ACTUALLY happened, on or before `today`.
 *
 * 🔴 Not the latest event. The payload carries estimates dated in the future
 * ("Estimated arrival", 6 October) alongside things that have happened, so
 * sorting the lot and taking the last answers "when is it due" while calling
 * itself "where is it now". On 22 Sep 2026 that made shipment 245446323 read
 * "Estimated arrival" when the cargo had been picked up on 15 September and was
 * sitting in Presov. Estimates and schedule-change exceptions are excluded here
 * and shown as the forward-looking dates they are.
 *
 * Cargo Partner's own tracking page shows more than one milestone when they
 * share a moment ("ARRIVED (Rio de Janeiro) / EMPTY CONTAINER RETURN"), so
 * anything on the same timestamp comes back in alsoNames.
 */
export function cargoStatus(
  events: CargoEventRow[],
  today: string,
  options?: { physicalOnly?: boolean },
): CargoStatus | null {
  const happened = events
    .filter((e) => e.kind === 'actual' && e.date <= today)
    .filter((e) => !options?.physicalOnly || isPhysicalMilestone(e.identifier))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  const last = happened[happened.length - 1]
  if (!last) return null
  const sameMoment = happened.filter((e) => e.date === last.date && e.time === last.time)
  const names: string[] = []
  for (const e of sameMoment) if (!names.includes(e.name)) names.push(e.name)
  return {
    name: last.name,
    date: last.date,
    location: last.locationName ?? last.locationCode,
    alsoNames: names.filter((n) => n !== last.name),
  }
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export type StopState = 'done' | 'current' | 'upcoming'

export interface TimelineStop {
  /** The heading, e.g. "PORT OF LOADING". */
  label: string
  /** PICKUP | PORT_OF_LOADING | TRANSIT_HUB | PORT_OF_DISCHARGE | DELIVERY */
  type: string
  code: string | null
  place: string | null
  countryCode: string | null
  /** The date to print, actual where there is one. */
  date: string | null
  /** 'Departed', 'Arrived', 'Pickup done', 'Due', 'Delivered'. */
  caption: string | null
  actual: boolean
  state: StopState
  /** How the cargo travels to the NEXT stop. Null on the last one. */
  legToNext: LegMode
}

const STOP_LABELS: Record<string, string> = {
  PICKUP: 'Pickup',
  PORT_OF_LOADING: 'Port of loading',
  TRANSIT_HUB: 'In transit',
  PORT_OF_DISCHARGE: 'Port of discharge',
  DELIVERY: 'Delivery',
}

/** A named stop outranks a transit hub when two merge into one place. */
const STOP_RANK: Record<string, number> = {
  TRANSIT_HUB: 0,
  PICKUP: 3,
  DELIVERY: 3,
  PORT_OF_LOADING: 2,
  PORT_OF_DISCHARGE: 2,
}

/**
 * Two points are the same stop when they are the same PLACE, which means
 * resolving the code before comparing. A pickup carries a city and no code
 * ("Presov") and the transit hub that follows it carries a code and no city
 * ("SKPOV"), and those are one warehouse, not two.
 */
function stopKey(p: CargoRoutingPoint): string {
  return (placeName(p.unlocode) ?? p.city ?? '').trim().toUpperCase()
}

/**
 * The route as a person reads it.
 *
 * Two things happen here that the raw array does not do for you. Adjacent points
 * in the SAME place are merged: a shipment out of Presov lists a pickup in
 * Presov and then a transit hub SKPOV, and Bremerhaven appears as a transit hub
 * and again as the port of loading. Drawing both is drawing the same warehouse
 * twice. And each stop is given the ONE date that matters for its kind, which is
 * a departure at the start of a journey and an arrival at the end of one, which
 * is what the forwarder's own diagram shows.
 */
export function cargoTimeline(route: CargoRoutingPoint[], events: CargoEventRow[], today: string): TimelineStop[] {
  const merged: CargoRoutingPoint[][] = []
  for (const p of route) {
    const prev = merged[merged.length - 1]
    const key = stopKey(p)
    if (prev && key && stopKey(prev[0]) === key) prev.push(p)
    else merged.push([p])
  }

  const milestones = cargoMilestones(events)

  const stops: TimelineStop[] = merged.map((group) => {
    const lead = [...group].sort((a, b) => (STOP_RANK[b.type] ?? 1) - (STOP_RANK[a.type] ?? 1))[0]
    const pick = <K extends keyof CargoRoutingPoint>(k: K) =>
      group.map((p) => p[k]).find((v) => v != null) ?? null

    const realDeparture = pick('realDeparture') as string | null
    const realArrival = pick('realArrival') as string | null
    const estDeparture = pick('estimatedDeparture') as string | null
    const estArrival = pick('estimatedArrival') as string | null

    let date: string | null = null
    let caption: string | null = null
    let actual = false

    if (lead.type === 'PICKUP') {
      // The collection itself is an event, not a routing date.
      date = milestones.pickedUp ?? estDeparture
      actual = Boolean(milestones.pickedUp)
      caption = actual ? 'Picked up' : date ? 'Cargo ready' : null
    } else if (lead.type === 'DELIVERY') {
      date = milestones.delivered ?? realArrival ?? estArrival
      actual = Boolean(milestones.delivered || realArrival)
      caption = actual ? 'Delivered' : date ? 'Due' : null
    } else if (lead.type === 'PORT_OF_LOADING') {
      date = realDeparture ?? estDeparture ?? realArrival ?? estArrival
      actual = Boolean(realDeparture)
      caption = actual ? 'Departed' : date ? 'Departs' : null
    } else {
      // A discharge port and a transit hub are both places you arrive at.
      date = realArrival ?? estArrival ?? realDeparture ?? estDeparture
      actual = Boolean(realArrival)
      caption = actual ? 'Arrived' : date ? 'Due' : null
    }

    return {
      label: STOP_LABELS[lead.type] ?? lead.type.replace(/_/g, ' ').toLowerCase(),
      type: lead.type,
      code: (pick('unlocode') as string | null),
      place: (pick('city') as string | null) ?? placeName(pick('unlocode') as string | null),
      countryCode: pick('countryCode') as string | null,
      date,
      caption,
      actual: actual && Boolean(date) && (date as string) <= today,
      state: 'upcoming' as StopState,
      legToNext: legMode(group[group.length - 1].legModality),
    }
  })

  // The last stop that has actually happened is where the cargo is, and a finished journey is at
  // its end. Cargo Partner often records no arrival at a rail hub or at the delivery address, but a
  // container that has gone back empty has been unloaded, so its route is drawn as travelled.
  let lastDone = -1
  for (let i = 0; i < stops.length; i++) if (stops[i].actual) lastDone = i
  if (cargoComplete(events)) lastDone = stops.length - 1
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    stop.state = i < lastDone ? 'done' : i === lastDone ? 'current' : 'upcoming'
    // A stop the cargo is already past is not "Due": it just has no recorded date of its own.
    if (stop.state !== 'upcoming' && !stop.actual) stop.caption = stop.type === 'DELIVERY' ? 'Delivered' : null
    // Nor is a rail or road hub whose date has gone by: Cargo Partner never confirms those, so a
    // passed date is not a delay. A port or the delivery keeps its "Due", because there it is.
    if (stop.state === 'upcoming' && stop.type === 'TRANSIT_HUB' && stop.date && stop.date.slice(0, 10) < today) stop.caption = null
  }
  return stops
}

/** Where the cargo is on the leg it is travelling, by the calendar. */
export interface LegProgress {
  /** The leg: from stops[leg] to stops[leg + 1]. */
  leg: number
  /** 0 when it has just left, 1 when the next stop is due. */
  fraction: number
  /** The next stop's date has passed and it has not arrived. */
  overdue: boolean
}

const dayOf = (iso: string | null) => (iso ? Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) : Number.NaN)

/**
 * Where the cargo is along its route by the calendar: the days since the last stop it reached,
 * against the dates the stops after it are due.
 *
 * Dean, 23 Sep 2026: "a little ship/little truck that shows progress along the shipment timeline
 * that is really just using the estimated date as a progress bar compared to todays date".
 *
 * Cargo Partner confirms ports and the delivery, but never records an arrival at a rail or road
 * hub in between: a finished journey through Zlin has no Zlin date. So the marker passes a transit
 * hub on its date alone, and waits, amber, only at a port or the delivery whose date has gone by. A
 * stop with no date takes an even share of the time between the dated stops either side of it.
 * Null when nothing has moved yet or the journey is over.
 */
export function legProgress(stops: TimelineStop[], today: string): LegProgress | null {
  const at = stops.findIndex((s) => s.state === 'current')
  if (at < 0 || at >= stops.length - 1) return null

  // The furthest the marker may go: the next stop Cargo Partner confirms.
  let target = stops.findIndex((s, i) => i > at && s.type !== 'TRANSIT_HUB')
  if (target < 0) target = stops.length - 1

  const now = dayOf(today)
  const due = stops.map((s, i) => (i < at ? Number.NaN : dayOf(s.date)))
  // Fill an undated stop from the dated stops either side of it.
  for (let i = at + 1; i <= target; i++) {
    if (Number.isFinite(due[i])) continue
    const before = i - 1
    let after = i + 1
    while (after < due.length && !Number.isFinite(due[after])) after++
    if (after < due.length && Number.isFinite(due[before])) {
      due[i] = due[before] + (due[after] - due[before]) / (after - before)
    }
  }
  if (!Number.isFinite(now) || !Number.isFinite(due[at])) return { leg: at, fraction: 0, overdue: false }

  if (Number.isFinite(due[target]) && now >= due[target]) {
    return { leg: target - 1, fraction: 1, overdue: now > due[target] }
  }
  for (let i = at; i < target; i++) {
    const from = due[i]
    const to = due[i + 1]
    // Beyond the last known date the marker waits at the start of the leg it cannot place.
    if (!Number.isFinite(to)) return { leg: i, fraction: 0, overdue: false }
    if (now < to) {
      return { leg: i, fraction: to > from ? Math.min(1, Math.max(0, (now - from) / (to - from))) : 1, overdue: false }
    }
  }
  return { leg: target - 1, fraction: 1, overdue: false }
}

/**
 * The single date to promise somebody: the delivery if it is known, otherwise
 * arrival at the port of discharge. Deliberately NOT the last routing point,
 * which can be a transhipment and would read as an arrival that is not one.
 */
export function cargoEta(route: CargoRoutingPoint[]): string | null {
  const delivery = route.find((p) => p.type === 'DELIVERY')
  if (delivery?.estimatedArrival) return delivery.estimatedArrival
  const discharge = [...route].reverse().find((p) => p.type === 'PORT_OF_DISCHARGE')
  return discharge?.realArrival ?? discharge?.estimatedArrival ?? null
}

/**
 * Has the journey finished?
 *
 * Cargo Partner does not reliably raise a DELIVERED event: of the 25 shipments
 * read on 22 Sep 2026 exactly one carried id 12, while every finished one
 * carried an empty container return. So a returned empty counts as done. It is
 * the container coming back to the carrier, which cannot happen with the goods
 * still inside it.
 */
export function cargoComplete(events: CargoEventRow[]): boolean {
  const m = cargoMilestones(events)
  return Boolean(m.delivered || m.emptyReturned)
}
