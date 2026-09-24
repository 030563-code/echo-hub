import type { CargoBoardRow } from '@/lib/cargo/store'
import { contentsSummary, handProgress, lineReferences, type HubShipment, type ShipmentLine } from './shipment'

/**
 * One row of the Logistics and Shipping board, whether Cargo Partner tracks the shipment or Dave
 * keeps it by hand. Pure: the page counts these and the board lists them.
 */
export interface BoardItem {
  /** What the row is found by, and its page: the SPOT ID, or the Hub's id for one kept by hand. */
  key: string
  spotId: string | null
  byHand: boolean
  containerNumbers: string[]
  generalReference: string | null
  vesselName: string | null
  oceanCarrier: string | null
  originCity: string | null
  destinationCity: string | null
  destinationDepot: string | null
  cargoDescription: string | null
  /** Packages, which for our containers are pallets. */
  totalPieces: number | null
  departedOn: string | null
  eta: string | null
  currentStatus: string | null
  currentStatusOn: string | null
  currentStatusLocation: string | null
  isComplete: boolean
  slipDays: number | null
  references: string[]
  /** "560 × H10HERCB on 8 pallets", from the Hub's own contents. */
  contents: string | null
}

function withLineReferences(own: readonly string[], lines: readonly ShipmentLine[]): string[] {
  const all = [...own]
  for (const r of lineReferences(lines)) if (!all.includes(r)) all.push(r)
  return all
}

export function bookedItem(row: CargoBoardRow, lines: readonly ShipmentLine[] = []): BoardItem {
  return {
    key: row.spotId,
    spotId: row.spotId,
    byHand: false,
    containerNumbers: row.containerNumbers,
    generalReference: row.generalReference,
    vesselName: row.vesselName,
    oceanCarrier: row.oceanCarrier,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    destinationDepot: row.destinationDepot,
    cargoDescription: row.cargoDescription,
    totalPieces: row.totalPieces,
    departedOn: row.departedOn,
    eta: row.eta,
    currentStatus: row.currentStatus,
    currentStatusOn: row.currentStatusOn,
    currentStatusLocation: row.currentStatusLocation,
    isComplete: row.isComplete,
    slipDays: row.slipDays,
    references: withLineReferences(row.references, lines),
    contents: contentsSummary(lines),
  }
}

export function handItem(s: HubShipment): BoardItem {
  const progress = handProgress(s)
  const pallets = s.lines.every((l) => l.pallets != null) && s.lines.length
    ? s.lines.reduce((sum, l) => sum + (l.pallets ?? 0), 0)
    : null
  return {
    key: s.id,
    spotId: null,
    byHand: true,
    containerNumbers: s.containers,
    generalReference: null,
    vesselName: null,
    oceanCarrier: null,
    originCity: null,
    destinationCity: null,
    destinationDepot: s.depot,
    cargoDescription: null,
    totalPieces: pallets,
    departedOn: s.shippedOn,
    eta: progress.eta,
    currentStatus: progress.status,
    currentStatusOn: progress.on,
    currentStatusLocation: null,
    isComplete: progress.isComplete,
    slipDays: null,
    references: lineReferences(s.lines),
    contents: contentsSummary(s.lines),
  }
}

/** In arrival order, the ones with no date last, the way the Cargo Partner board already sorts. */
export function boardItems(
  booked: readonly CargoBoardRow[],
  linesBySpot: ReadonlyMap<string, ShipmentLine[]>,
  hand: readonly HubShipment[],
): BoardItem[] {
  const items = [...booked.map((r) => bookedItem(r, linesBySpot.get(r.spotId) ?? [])), ...hand.map(handItem)]
  return items.sort((a, b) => {
    if (a.eta === b.eta) return 0
    if (a.eta == null) return 1
    if (b.eta == null) return -1
    return a.eta < b.eta ? -1 : 1
  })
}
