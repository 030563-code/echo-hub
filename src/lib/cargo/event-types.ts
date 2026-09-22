/**
 * The Cargo Partner event vocabulary, by its numeric identifier.
 *
 * Taken from 25 real shipment payloads pulled on 22 Sep 2026 (every SPOT ID the
 * Hub and Dave's sheet know about). The API sends both a numeric identifier and
 * a name; the identifier is what we key on, because a name is a label and a
 * label can be reworded or localised without warning.
 *
 * 🔴 The distinction that matters: an ESTIMATE is dated in the FUTURE. Sorting
 * every event by timestamp and taking the last one therefore answers "when is it
 * due" and calls it "where is it now". On 22 Sep 2026 that made shipment
 * 245446323 read "Estimated arrival", dated 6 October, when the true position was
 * PICKED UP on 15 September. An EXCEPTION is a schedule change and carries the
 * slip in its remark ("ETA Port of Discharge Changed: 2 day(s)"), which is the
 * one field in the whole payload that measures lateness directly.
 *
 * Note the spelling of eventTypeIdenfitifer. That typo is theirs and it is in
 * the live response, so it is load bearing.
 */

export type EventKind = 'actual' | 'estimate' | 'exception'

/** Identifier → what the event tells us. Names are the API's own wording. */
export const CARGO_EVENT_TYPES: Record<string, { name: string; kind: EventKind }> = {
  '1': { name: 'Estimated arrival', kind: 'estimate' },
  '2': { name: 'Estimated pickup', kind: 'estimate' },
  '4': { name: 'Arrived', kind: 'actual' },
  '5': { name: 'Estimated departure', kind: 'estimate' },
  '7': { name: 'Departed', kind: 'actual' },
  '9': { name: 'Picked up', kind: 'actual' },
  '10': { name: 'Estimated delivery', kind: 'estimate' },
  '12': { name: 'Delivered', kind: 'actual' },
  '13': { name: 'Estimated cargo readiness', kind: 'estimate' },
  '20': { name: 'Handling finished', kind: 'actual' },
  '21': { name: 'Pre-alert processed', kind: 'actual' },
  '24': { name: 'Export customs cleared', kind: 'actual' },
  '31': { name: 'Unloaded from vessel', kind: 'actual' },
  '34': { name: 'Empty container picked up', kind: 'actual' },
  '35': { name: 'Empty container returned', kind: 'actual' },
  '36': { name: 'Gate out', kind: 'actual' },
  '37': { name: 'Gate in', kind: 'actual' },
  '50': { name: 'Booking confirmed', kind: 'actual' },
  '51': { name: 'Booking requested', kind: 'actual' },
  '90': { name: 'Loaded on vessel', kind: 'actual' },
  '92': { name: 'ETA changed at the port of discharge', kind: 'exception' },
  '93': { name: 'ETD changed at the port of loading', kind: 'exception' },
  '95': { name: 'Approved by decision maker', kind: 'actual' },
}

/**
 * An identifier we have never seen counts as an actual, so a new milestone shows
 * up on the board instead of disappearing. Its own name is used, since we have
 * nothing better, and the sync records it so somebody can classify it.
 */
export function eventKind(identifier: string): EventKind {
  return CARGO_EVENT_TYPES[identifier]?.kind ?? 'actual'
}

/** Our wording where we have it, the API's where we do not. */
export function eventLabel(identifier: string, apiName: string): string {
  return CARGO_EVENT_TYPES[identifier]?.name ?? apiName
}

/** The milestones a lead time is measured between, in route order. */
export const MILESTONE_IDS = {
  cargoReady: '13',
  pickedUp: '9',
  loadedOnVessel: '90',
  departed: '7',
  unloaded: '31',
  arrived: '4',
  delivered: '12',
  emptyReturned: '35',
} as const

/**
 * "ETA Port of Discharge Changed: 2 day(s)" → 2, and a pulled-forward
 * "-1 day(s)" → -1. Null when the remark says nothing about days, so a caller
 * can tell "no slip recorded" from "slipped by zero".
 */
export function delayDaysFromRemark(remark: string | null | undefined): number | null {
  const m = /(-?\d+)\s*day\(s\)/i.exec(remark ?? '')
  return m ? Number(m[1]) : null
}

/**
 * The milestones that are a container moving, as opposed to paperwork moving.
 *
 * A customer opening a tracking link should not be told the latest news is
 * "Pre-alert processed", which is a thing that happened in an office in
 * Bratislava. Internally every milestone is shown, because internally the
 * paperwork matters. Nothing is hidden by this: a physical event that happened
 * LATER always wins, so the customer never sees an older position than we do.
 */
const PAPERWORK_IDS = new Set([
  '20', // Handling finished
  '21', // Pre-alert processed
  '50', // Booking confirmed
  '51', // Booking requested
  '95', // Approved by decision maker
])

export function isPhysicalMilestone(identifier: string): boolean {
  return !PAPERWORK_IDS.has(identifier)
}
