import type { CustomsPackage } from '@/lib/customs/nippon-invoice'

/**
 * Which shipment in Transport a Nippon Express package belongs to.
 *
 * Dean, 23 Sep 2026: "The invoices should have the Invoice Number as a link to which shipment it
 * is." The strongest key is the SPOT ID printed on the Consoltainer Line sea waybill inside the
 * package. Not every package has the waybill (26NEU-445-D8400 does not), so the fall-backs are the
 * container number, then the master bill of lading, then the house bill. Nippon prints the house
 * bill without the line's prefix: its "KS0001391389" is Cargo Partner's "CTLTKS0001391389".
 */

export type MatchMethod = 'spot' | 'container' | 'mbl' | 'hbl'

export interface ShipmentKeys {
  spotId: string
  hbl: string | null
  mbl: string | null
  containers: string[]
}

export interface ShipmentMatch {
  spotId: string
  method: MatchMethod
}

const norm = (value: string | null | undefined) => String(value ?? '').replace(/[\s-]/g, '').toUpperCase()

export function matchShipment(pkg: CustomsPackage, shipments: readonly ShipmentKeys[]): ShipmentMatch | null {
  const spot = norm(pkg.waybill.spot_id)
  if (spot) {
    const hit = shipments.find((s) => norm(s.spotId) === spot)
    if (hit) return { spotId: hit.spotId, method: 'spot' }
  }

  const containers = new Set(pkg.waybill.container_numbers.map(norm).filter(Boolean))
  if (containers.size) {
    const hit = shipments.find((s) => s.containers.some((c) => containers.has(norm(c))))
    if (hit) return { spotId: hit.spotId, method: 'container' }
  }

  const mbl = norm(pkg.invoice.bl_master ?? pkg.entry?.bl_number)
  if (mbl) {
    const hit = shipments.find((s) => norm(s.mbl) === mbl)
    if (hit) return { spotId: hit.spotId, method: 'mbl' }
  }

  // A house bill needs enough characters to be unique before a suffix match means anything.
  const hbl = norm(pkg.waybill.hbl ?? pkg.invoice.bl_house)
  if (hbl.length >= 8) {
    const hit = shipments.find((s) => {
      const theirs = norm(s.hbl)
      return theirs !== '' && (theirs === hbl || theirs.endsWith(hbl) || hbl.endsWith(theirs))
    })
    if (hit) return { spotId: hit.spotId, method: 'hbl' }
  }

  return null
}

/** The keys a package can be matched on, for the database query that finds the candidates. */
export function matchKeysOf(pkg: CustomsPackage): { spotIds: string[]; containers: string[]; mbls: string[] } {
  return {
    spotIds: pkg.waybill.spot_id ? [pkg.waybill.spot_id] : [],
    containers: pkg.waybill.container_numbers,
    mbls: [pkg.invoice.bl_master, pkg.entry?.bl_number].filter((v): v is string => Boolean(v)),
  }
}
