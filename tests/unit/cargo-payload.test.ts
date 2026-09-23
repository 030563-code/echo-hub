import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseCargoPayload,
  cargoTimeline,
  cargoStatus,
  cargoMilestones,
  cargoEta,
  cargoComplete,
  daysBetween,
  legProgress,
  type CargoEventRow,
  type CargoRoutingPoint,
  type TimelineStop,
} from '@/lib/cargo/payload'
import { delayDaysFromRemark, eventKind, CARGO_EVENT_TYPES } from '@/lib/cargo/event-types'
import { placeName, tidyCity, legMode } from '@/lib/cargo/places'

/**
 * The Cargo Partner payload, pinned against SIX REAL SHIPMENTS pulled from the
 * live API on 22 September 2026. Not hand-written fixtures: the whole response
 * as the forwarder sent it, so a change in their shape fails here rather than on
 * a screen somebody is showing a customer.
 *
 * The six were chosen to cover the range: three in transit that day at three
 * different stages, one finished, one out of Britain instead of Slovakia, and
 * one with a transhipment in the middle.
 */

const fixture = (id: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/cargo', `${id}.json`), 'utf8'))

/** The day the fixtures were pulled. Every "now" in this file is that day. */
const TODAY = '2026-09-22'

const HAMILTON_WAITING = '245446323' // picked up, not yet at the port of loading
const NORFOLK_BOOKED = '245490305' // cleared customs, still inland
const NORFOLK_SAILING = '244498887' // departed Bremerhaven, at sea
const HAMILTON_DONE = '243291911' // arrived Montreal, empty returned
const BALTIMORE_OLD = '235541471' // finished in February, a transhipment en route
const FROM_BRITAIN = '237090493' // ships out of London Gateway, not Slovakia

describe('the payload is read as the API actually sends it', () => {
  it('reads an event location from eventLocation, not from a location that is not there', () => {
    // The previous parser read e.location.name. No such field exists in the
    // response, so every event location came back undefined.
    const { events } = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    const located = events.filter((e) => e.locationCode || e.locationName)
    expect(located.length).toBeGreaterThan(0)
    expect(located.some((e) => e.locationName === 'Bremerhaven')).toBe(true)
  })

  it('drops a free-text location that says nothing', () => {
    // The API sends "no location" and "unknown" as literal names.
    const { events } = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    const names = events.map((e) => e.locationName).filter((n): n is string => n !== null)
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n).not.toMatch(/^(no location|unknown)$/i)
  })

  it('reads a routing point from unlocode, not from a location object', () => {
    const { route } = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    const coded = route.filter((p) => p.unlocode)
    expect(coded.length).toBeGreaterThan(0)
    expect(coded.map((p) => p.unlocode)).toContain('DEBRV')
  })

  it('keeps the vessel, the carrier, the bills of lading and the container', () => {
    const { header, containers } = parseCargoPayload(fixture(BALTIMORE_OLD), BALTIMORE_OLD)
    expect(header.vesselName).toBe('MAERSK FREDERICIA')
    expect(header.oceanCarrier).toBe('HAPAG LLOYD')
    expect(header.voyageNumber).toBe('602W')
    expect(header.mbl).toBe('HLCUPRG251204014')
    expect(containers).toHaveLength(1)
    expect(containers[0]).toMatchObject({ number: 'FANU3080006', code: '45GP', seal: '0440760' })
  })

  it('puts the customer order number first among the references', () => {
    const { header } = parseCargoPayload(fixture(BALTIMORE_OLD), BALTIMORE_OLD)
    expect(header.generalReference).toBe('PO-00001265')
    expect(header.references[0].type).toBe('GENERAL_REFERENCE')
    expect(header.references.map((r) => r.type)).toContain('CDM')
  })

  it('tidies a shouted city without touching one that is already written properly', () => {
    expect(tidyCity('PRESOV')).toBe('Presov')
    expect(tidyCity('BURY ST. EDMUNDS')).toBe('Bury St. Edmunds')
    expect(tidyCity('Rancho Cucamonga')).toBe('Rancho Cucamonga')
    expect(tidyCity('Kosice - mestska casť Juh')).toBe('Kosice - mestska casť Juh')
    expect(tidyCity('')).toBeNull()
  })

  it('names a port instead of printing its code, and passes an unknown code through', () => {
    expect(placeName('DEBRV')).toBe('Bremerhaven')
    expect(placeName('USORF')).toBe('Norfolk')
    expect(placeName('ZZZZZ')).toBe('ZZZZZ')
    expect(placeName(null)).toBeNull()
  })

  it('reads how the cargo travels on each leg', () => {
    expect(legMode('SEA_FCL')).toBe('sea')
    expect(legMode('RAIL_FCL')).toBe('rail')
    expect(legMode('ROAD_FTL')).toBe('road')
    expect(legMode(null)).toBeNull()
  })
})

describe('where is it now', () => {
  /**
   * 🔴 The bug this exists to stop. The payload carries estimates dated in the
   * FUTURE. Sorting every event and taking the last one answers "when is it due"
   * while calling itself "where is it now", and on 22 Sep 2026 that made this
   * shipment read "Estimated arrival", dated 6 October, when the cargo had been
   * collected on 15 September and had not yet reached the port.
   */
  it('never reports a future estimate as the current position', () => {
    const { events } = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    const naive = [...events].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).at(-1)
    expect(naive?.name).toBe('Estimated arrival')
    expect(naive?.date).toBe('2026-10-06')

    const status = cargoStatus(events, TODAY)
    expect(status?.name).toBe('Picked up')
    expect(status?.date).toBe('2026-09-15')
    expect(status!.date <= TODAY).toBe(true)
  })

  it('reports the real position for a shipment at sea', () => {
    const { events } = parseCargoPayload(fixture(NORFOLK_SAILING), NORFOLK_SAILING)
    const status = cargoStatus(events, TODAY)
    expect(status?.date).toBe('2026-09-09')
    expect(status!.date <= TODAY).toBe(true)
  })

  it('carries the other milestones that happened at the same moment', () => {
    // Cargo Partner's own page shows two at once when they share a timestamp,
    // e.g. "ARRIVED (Rio de Janeiro) / EMPTY CONTAINER RETURN (Rio de Janeiro)".
    const { events } = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    const status = cargoStatus(events, TODAY)
    expect(status).not.toBeNull()
    expect(Array.isArray(status!.alsoNames)).toBe(true)
  })

  it('answers nothing rather than guessing when nothing has happened yet', () => {
    expect(cargoStatus([], TODAY)).toBeNull()
  })

  it('does not report an event that has not happened yet on an earlier day', () => {
    const { events } = parseCargoPayload(fixture(NORFOLK_SAILING), NORFOLK_SAILING)
    const early = cargoStatus(events, '2026-08-25')
    expect(early).not.toBeNull()
    expect(early!.date <= '2026-08-25').toBe(true)
  })
})

describe('the timeline is built from the route, never from a template', () => {
  it('gives each shipment the number of stops its own route has', () => {
    const shapes = [HAMILTON_WAITING, NORFOLK_BOOKED, NORFOLK_SAILING, HAMILTON_DONE, BALTIMORE_OLD, FROM_BRITAIN].map(
      (id) => {
        const p = parseCargoPayload(fixture(id), id)
        return cargoTimeline(p.route, p.events, TODAY).length
      },
    )
    // Not all the same number: a template of four stops would make them equal.
    expect(new Set(shapes).size).toBeGreaterThan(1)
    for (const n of shapes) expect(n).toBeGreaterThanOrEqual(2)
  })

  it('draws one stop per place, not one per routing point', () => {
    // Presov is both the pickup and the first transit hub (SKPOV), and
    // Bremerhaven is both a transit hub and the port of loading. Drawing each
    // twice draws the same warehouse twice.
    const p = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    expect(p.route.length).toBe(7)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    expect(stops.map((s) => s.place)).toEqual(['Presov', 'Bremerhaven', 'Montreal', 'Hamilton'])
    expect(stops.map((s) => s.type)).toEqual([
      'PICKUP',
      'PORT_OF_LOADING',
      'PORT_OF_DISCHARGE',
      'DELIVERY',
    ])
  })

  it('keeps a genuine transhipment as its own stop', () => {
    const p = parseCargoPayload(fixture(NORFOLK_BOOKED), NORFOLK_BOOKED)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    expect(stops.map((s) => s.place)).toContain('Zlin')
    expect(stops.find((s) => s.place === 'Zlin')?.type).toBe('TRANSIT_HUB')
  })

  it('shows a departure at the port of loading and an arrival at the port of discharge', () => {
    const p = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    const pol = stops.find((s) => s.type === 'PORT_OF_LOADING')!
    const pod = stops.find((s) => s.type === 'PORT_OF_DISCHARGE')!
    expect(pol.caption).toBe('Departed')
    expect(pol.date).toBe('2026-08-01')
    expect(pod.caption).toBe('Arrived')
    expect(pod.date).toBe('2026-08-10')
  })

  it('marks exactly one stop as the current one, and only when something has happened', () => {
    for (const id of [HAMILTON_WAITING, NORFOLK_SAILING, HAMILTON_DONE]) {
      const p = parseCargoPayload(fixture(id), id)
      const stops = cargoTimeline(p.route, p.events, TODAY)
      expect(stops.filter((s) => s.state === 'current'), id).toHaveLength(1)
    }
  })

  it('never marks a stop done on a date that has not arrived', () => {
    for (const id of [HAMILTON_WAITING, NORFOLK_BOOKED, NORFOLK_SAILING]) {
      const p = parseCargoPayload(fixture(id), id)
      for (const s of cargoTimeline(p.route, p.events, TODAY)) {
        if (s.state === 'done' || s.state === 'current') {
          if (s.date) expect(s.date <= TODAY, `${id} ${s.label} ${s.date}`).toBe(true)
        }
      }
    }
  })

  it('says how the cargo travels between stops', () => {
    const p = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    expect(stops.find((s) => s.type === 'PORT_OF_LOADING')?.legToNext).toBe('sea')
    expect(stops.at(-1)?.legToNext).toBeNull()
  })

  it('survives a payload with no routing information at all', () => {
    expect(cargoTimeline([], [], TODAY)).toEqual([])
    const empty = parseCargoPayload({}, 'X')
    expect(empty.route).toEqual([])
    expect(empty.events).toEqual([])
    expect(empty.containers).toEqual([])
    expect(empty.header.spotId).toBe('X')
  })
})

describe('milestones, which is what a lead time is measured between', () => {
  it('takes the first stamp of a milestone, not the last', () => {
    // A shipment with two containers raises "Loaded on vessel" once per
    // container. The leg began at the earliest of them.
    const p = parseCargoPayload(fixture(BALTIMORE_OLD), BALTIMORE_OLD)
    const m = cargoMilestones(p.events)
    const allLoaded = p.events.filter((e) => e.identifier === '90').map((e) => e.date).sort()
    expect(m.loadedOnVessel).toBe(allLoaded[0])
  })

  it('measures the real journey of a finished shipment', () => {
    const p = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    const m = cargoMilestones(p.events)
    expect(m.pickedUp).toBe('2026-07-17')
    expect(m.loadedOnVessel).toBe('2026-08-01')
    const door = daysBetween(m.pickedUp, m.emptyReturned)
    expect(door).not.toBeNull()
    expect(door!).toBeGreaterThan(0)
  })

  it('counts days between two dates and refuses to invent one', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetween('2026-03-01', '2026-02-27')).toBe(-2)
    expect(daysBetween(null, '2026-01-01')).toBeNull()
    expect(daysBetween('2026-01-01', null)).toBeNull()
    expect(daysBetween('rubbish', '2026-01-01')).toBeNull()
  })

  it('treats a returned empty as the journey finishing, because a delivered event is rare', () => {
    const done = parseCargoPayload(fixture(HAMILTON_DONE), HAMILTON_DONE)
    expect(cargoComplete(done.events)).toBe(true)
    const sailing = parseCargoPayload(fixture(NORFOLK_SAILING), NORFOLK_SAILING)
    expect(cargoComplete(sailing.events)).toBe(false)
  })

  it('promises the delivery date, or the arrival at the discharge port, never a transhipment', () => {
    const p = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    expect(cargoEta(p.route)).toBe('2026-10-06')
    const discharge = p.route.find((r) => r.type === 'PORT_OF_DISCHARGE')
    expect(cargoEta(p.route)).toBe(discharge?.estimatedArrival)
    expect(cargoEta([])).toBeNull()
  })
})

describe('the delay signal, which is the one figure that measures lateness', () => {
  it('reads the slip in days out of an exception remark, in both directions', () => {
    expect(delayDaysFromRemark('ETA Port of Discharge Changed: 7 day(s)')).toBe(7)
    expect(delayDaysFromRemark('ETD Port of Loading Changed: -2 day(s)')).toBe(-2)
    expect(delayDaysFromRemark('Event generated from Container(s) by SPOT')).toBeNull()
    expect(delayDaysFromRemark(null)).toBeNull()
  })

  it('finds real slips in the live shipments', () => {
    const p = parseCargoPayload(fixture(HAMILTON_WAITING), HAMILTON_WAITING)
    const slips = p.events.filter((e) => e.kind === 'exception' && e.delayDays !== null)
    expect(slips.length).toBeGreaterThan(0)
    for (const s of slips) expect(Number.isInteger(s.delayDays)).toBe(true)
  })
})

describe('the event vocabulary', () => {
  it('classifies an estimate as an estimate and a milestone as a milestone', () => {
    expect(eventKind('1')).toBe('estimate') // Estimated arrival
    expect(eventKind('5')).toBe('estimate') // Estimated departure
    expect(eventKind('9')).toBe('actual') // Picked up
    expect(eventKind('90')).toBe('actual') // Loaded on vessel
    expect(eventKind('92')).toBe('exception') // ETA changed
    expect(eventKind('93')).toBe('exception') // ETD changed
  })

  it('treats an identifier nobody has seen as something that happened', () => {
    // So a new milestone shows on the board rather than vanishing from it.
    expect(eventKind('4242')).toBe('actual')
  })

  it('covers every identifier the six fixtures contain', () => {
    const seen = new Set<string>()
    for (const id of [HAMILTON_WAITING, NORFOLK_BOOKED, NORFOLK_SAILING, HAMILTON_DONE, BALTIMORE_OLD, FROM_BRITAIN]) {
      for (const e of parseCargoPayload(fixture(id), id).events) seen.add(e.identifier)
    }
    const unknown = [...seen].filter((i) => !CARGO_EVENT_TYPES[i])
    expect(unknown, `unclassified event identifiers: ${unknown.join(', ')}`).toEqual([])
  })
})

describe('a finished journey is drawn as travelled', () => {
  it('reaches every stop once the empty container is back, even the ones never dated', () => {
    const p = parseCargoPayload(fixture(BALTIMORE_OLD), BALTIMORE_OLD)
    expect(cargoComplete(p.events)).toBe(true)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    expect(stops.at(-1)?.state).toBe('current')
    expect(stops.slice(0, -1).every((s) => s.state === 'done')).toBe(true)
    expect(stops.at(-1)?.caption).toBe('Delivered')
  })

  it('never calls a stop the cargo is past "Due"', () => {
    for (const id of [HAMILTON_WAITING, NORFOLK_BOOKED, NORFOLK_SAILING, HAMILTON_DONE, BALTIMORE_OLD, FROM_BRITAIN]) {
      const p = parseCargoPayload(fixture(id), id)
      for (const s of cargoTimeline(p.route, p.events, TODAY)) {
        if (s.state !== 'upcoming') expect(s.caption, `${id} ${s.label}`).not.toBe('Due')
      }
    }
  })
})

describe('a stop the cargo is past, on a made-up route shaped like a real one', () => {
  // Road to a rail hub nobody dates, sea, then rail and road inland: the shape that showed
  // "Due" under a green tick on 23 Sep 2026. Invented figures, not a real shipment.
  const point = (seq: number, type: string, city: string, dates: Partial<CargoRoutingPoint> = {}): CargoRoutingPoint => ({
    seq,
    type,
    unlocode: null,
    countryCode: null,
    city,
    legModality: null,
    estimatedDeparture: null,
    realDeparture: null,
    estimatedArrival: null,
    realArrival: null,
    ...dates,
  })
  const route = [
    point(1, 'PICKUP', 'Presov', { legModality: 'ROAD', estimatedDeparture: '2026-06-22' }),
    point(2, 'TRANSIT_HUB', 'Zlin', { legModality: 'RAIL', estimatedArrival: '2026-07-01' }),
    point(3, 'PORT_OF_LOADING', 'Bremerhaven', { legModality: 'SEA', realDeparture: '2026-07-24' }),
    point(4, 'PORT_OF_DISCHARGE', 'Norfolk', { legModality: 'RAIL', realArrival: '2026-08-07' }),
    point(5, 'TRANSIT_HUB', 'Harrisburg', { legModality: 'ROAD', estimatedArrival: '2026-08-08' }),
    point(6, 'DELIVERY', 'Jessup'),
  ]
  const event = (identifier: string, date: string): CargoEventRow => ({
    identifier,
    name: identifier,
    kind: 'actual',
    date,
    time: '',
    locationCode: null,
    locationName: null,
    containerNumber: null,
    remark: null,
    delayDays: null,
    delaySeconds: null,
  })

  it('shows no "Due" under a stop already passed', () => {
    const stops = cargoTimeline(route, [event('9', '2026-06-23')], '2026-08-07')
    const zlin = stops.find((s) => s.place === 'Zlin')!
    expect(zlin.state).toBe('done')
    expect(zlin.caption).toBeNull()
    // Still ahead, so still due.
    expect(stops.find((s) => s.place === 'Harrisburg')?.caption).toBe('Due')
  })

  it('does not call a rail hub late once its date has gone by, since nobody confirms one', () => {
    const stops = cargoTimeline(route, [event('9', '2026-06-23')], '2026-08-20')
    const harrisburg = stops.find((s) => s.place === 'Harrisburg')!
    expect(harrisburg.state).toBe('upcoming')
    expect(harrisburg.caption).toBeNull()
  })

  it('reaches Harrisburg and Jessup once the empty container is back', () => {
    const stops = cargoTimeline(route, [event('9', '2026-06-23'), event('35', '2026-08-24')], '2026-08-25')
    expect(stops.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'current'])
    expect(stops.find((s) => s.place === 'Harrisburg')?.caption).toBeNull()
    expect(stops.at(-1)?.caption).toBe('Delivered')
  })
})

describe('the ship on the leg under way', () => {
  const stop = (state: TimelineStop['state'], date: string | null, type = 'TRANSIT_HUB'): TimelineStop => ({
    label: 'x',
    type,
    code: null,
    place: null,
    countryCode: null,
    date,
    caption: null,
    actual: state !== 'upcoming',
    state,
    legToNext: 'sea',
  })

  it('sits where the calendar puts it between the stop it left and the one it is due at', () => {
    // Left Bremerhaven on 9 Sep, due at Norfolk on 27 Sep: on 23 Sep it is 14 of 18 days out.
    const stops = [stop('done', '2026-08-24'), stop('current', '2026-09-09'), stop('upcoming', '2026-09-27')]
    const at = legProgress(stops, '2026-09-23')!
    expect(at.leg).toBe(1)
    expect(at.fraction).toBeCloseTo(14 / 18, 6)
    expect(at.overdue).toBe(false)
  })

  it('waits at the end of the leg, marked late, once the due date has gone by', () => {
    const at = legProgress([stop('current', '2026-09-01'), stop('upcoming', '2026-09-10')], '2026-09-23')!
    expect(at.fraction).toBe(1)
    expect(at.overdue).toBe(true)
  })

  it('gives an undated stop an even share of the time to the next dated one', () => {
    // Harrisburg has no date: Norfolk 1 Oct to Jessup 11 Oct is ten days, five of them to Harrisburg.
    const stops = [stop('current', '2026-10-01'), stop('upcoming', null), stop('upcoming', '2026-10-11')]
    expect(legProgress(stops, '2026-10-03')!.fraction).toBeCloseTo(2 / 5, 6)
  })

  it('passes a rail hub the forwarder never confirms, on its date alone', () => {
    // Picked up 11 Sep, the Zlin hub due 21 Sep, Bremerhaven 26 Sep: on 23 Sep it is 2 of 5 days past Zlin.
    const stops = [
      stop('current', '2026-09-11', 'PICKUP'),
      stop('upcoming', '2026-09-21', 'TRANSIT_HUB'),
      stop('upcoming', '2026-09-26', 'PORT_OF_LOADING'),
    ]
    const at = legProgress(stops, '2026-09-23')!
    expect(at.leg).toBe(1)
    expect(at.fraction).toBeCloseTo(2 / 5, 6)
    expect(at.overdue).toBe(false)
  })

  it('waits, late, at a port whose date has gone by, never past it', () => {
    const stops = [
      stop('current', '2026-09-11', 'PICKUP'),
      stop('upcoming', '2026-09-15', 'TRANSIT_HUB'),
      stop('upcoming', '2026-09-20', 'PORT_OF_LOADING'),
      stop('upcoming', '2026-10-10', 'PORT_OF_DISCHARGE'),
    ]
    expect(legProgress(stops, '2026-09-23')).toEqual({ leg: 1, fraction: 1, overdue: true })
  })

  it('draws no ship before anything has moved, or after the journey is over', () => {
    expect(legProgress([stop('upcoming', '2026-09-30'), stop('upcoming', '2026-10-20')], '2026-09-23')).toBeNull()
    expect(legProgress([stop('done', '2026-09-01'), stop('current', '2026-09-20')], '2026-09-23')).toBeNull()
  })

  it('places the ship on the real sailing on the day the fixtures were pulled', () => {
    const p = parseCargoPayload(fixture(NORFOLK_SAILING), NORFOLK_SAILING)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    const at = legProgress(stops, TODAY)!
    expect(stops[at.leg].type).toBe('PORT_OF_LOADING')
    expect(at.fraction).toBeGreaterThan(0)
    expect(at.fraction).toBeLessThan(1)
  })
})
