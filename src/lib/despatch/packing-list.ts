/**
 * The PACKING LIST, as data.
 *
 * Two of these leave Kosice with every shipment and both are typed by hand
 * today: PL-A on Echo Barrier s.r.o. letterhead and PL-B on Echo Barrier Group
 * Limited letterhead, carrying the same pallets and the same weights. The only
 * differences are the letterhead and the consignee, so ONE document is built
 * here and rendered twice, rather than two builders that can drift apart.
 *
 * Pure, so it is unit-testable with no database and no jsPDF. The tests
 * reproduce four real Bamida packing lists to the kilogram.
 *
 * WHAT THIS DOES NOT DECIDE. Three things are inputs rather than rules, because
 * the real documents show no rule to infer:
 *
 *  1. THE CONSIGNEE VARIES and is not the party we invoice. Jessup went to
 *     "Echo Barrier USA Head Office" on both copies while the s.r.o. invoice
 *     was raised on Group; Canada and the UK name Group on the A copy; France
 *     names ESPACE DISTRIB, a direct customer, on the A copy. Anyone deriving a
 *     consignee from the invoice leg will be wrong about a third of the time.
 *  2. THE PALLET LAYOUT is a packing decision. The default below is whole
 *     pallets per product plus a remainder, which is what every clean document
 *     shows, but France put one cutting station and one frame on a single
 *     pallet and Jessup laid a frame loose in the container. The caller may
 *     replace `pallets` wholesale.
 *  3. THE PALLET NUMBERS come from a monthly counter that belongs to the
 *     factory, not to the order. See palletRef in pack-weights.ts.
 *
 * 🔴 THE SIGNED PACKING COUNT WINS. `SupplierSpecPacking.pallets` is what Juraj
 * signed on the manufacturing specification, and on the live order it says 8
 * while the per-product arithmetic makes 7. That disagreement is real and it is
 * the same one Dean caught on the -1 document on 21 Sep 2026. The UNITS figure
 * prints the signed count and a warning names the difference. It is never
 * silently reconciled by changing one of them.
 */

import { grossKg, netKg, palletRef, unitNetKgFor, WEIGHTS_CONFIRMED } from '@/lib/despatch/pack-weights'

export type PackingListVariant = 'A' | 'B'

export interface PackingListParty {
  name: string
  address: string[]
  /** Registration or VAT lines printed under the address. */
  identifiers?: string[]
}

export interface PackingListContact {
  name: string | null
  phone: string | null
  email: string | null
}

/** One row of the upper table: what is in the container and under which order. */
export interface PackingListLine {
  description: string
  hsCode: string | null
  quantity: number
  poReference: string | null
  /** Printed in their "Weight per pc" column when every line has one. */
  unitNetKg: number | null
}

/** One row of the lower table: one pallet, or one loose item. */
export interface PackingListPallet {
  ref: string
  description: string
  /** Their wording: "210 x 140 cm / height 235 cm", or "loosely laid". */
  packingSize: string
  netKg: number
  grossKg: number
  loose: boolean
}

export interface PackingListDoc {
  variant: PackingListVariant
  issuer: PackingListParty
  date: string
  placeOfCollection: string[]
  consignee: PackingListParty
  deliverTo: PackingListParty
  attention: PackingListContact
  incoterms: string | null
  lines: PackingListLine[]
  pallets: PackingListPallet[]
  totalNetKg: number
  totalGrossKg: number
  /** What the UNITS row prints. The signed count, not the computed one. */
  units: number
  comments: string | null
  /** False while the weight table is unconfirmed, which the PDF states. */
  weightsConfirmed: boolean
  /** Everything the builder could not resolve. Printed nowhere; shown in the Hub. */
  warnings: string[]
}

/** One product as the manufacturing specification already holds it. */
export interface PackingListProduct {
  model: string
  /** The printed description, e.g. "Echo Barrier H9 (1335 x 2050 mm)". */
  description: string
  quantity: number
  packSize: number
  /** Whether this build carries a mesh back, which changes the weight. */
  hasMesh?: boolean
  hsCode?: string | null
  poReference?: string | null
  /** Their pallet wording for this model. */
  packingSize?: string | null
}

export interface BuildPackingListInput {
  variant: PackingListVariant
  issuer: PackingListParty
  date: string
  placeOfCollection: string[]
  consignee: PackingListParty
  deliverTo: PackingListParty
  attention?: Partial<PackingListContact>
  incoterms?: string | null
  products: PackingListProduct[]
  /** The signed pallet count from the manufacturing specification. */
  signedPallets: number | null
  /** yyyy-mm the pallet references are numbered in. */
  palletMonth: string
  /** This shipment's first pallet number in the factory's monthly sequence. */
  firstPalletNumber: number
  comments?: string | null
  /** Replaces the computed layout entirely, for a hand-packed container. */
  palletsOverride?: PackingListPallet[]
}

const DEFAULT_PACKING_SIZE = '210 x 140 cm / height 235 cm'
const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * Split a product into whole pallets plus a remainder.
 *
 * A remainder pallet is a real pallet: 75 H9 is two pallets, not 1.07, which is
 * the same rounding palletsFor() applies for the specification and the priced
 * order. The remainder's weight is its OWN contents, so a pallet of five leftover
 * barriers does not print the weight of a full one.
 */
export function palletLoads(quantity: number, packSize: number): number[] {
  if (!(quantity > 0) || !(packSize > 0)) return []
  const whole = Math.floor(quantity / packSize)
  const remainder = quantity - whole * packSize
  const loads = new Array(whole).fill(packSize)
  if (remainder > 0) loads.push(remainder)
  return loads
}

export function buildPackingList(input: BuildPackingListInput): PackingListDoc {
  const warnings: string[] = []

  const lines: PackingListLine[] = input.products.map((p) => {
    const unit = unitNetKgFor(p.model, p.hasMesh ?? false)
    if (unit === null) {
      warnings.push(
        `No weight held for ${p.model}, so its pallets carry no net or gross figure. Add it to PACK_WEIGHT in pack-weights.ts once it has been weighed.`,
      )
    }
    if (!p.hsCode) {
      warnings.push(`No HS code for ${p.model}. A packing list crossing a customs border needs one on every line.`)
    }
    return {
      description: p.description,
      hsCode: p.hsCode ?? null,
      quantity: p.quantity,
      poReference: p.poReference ?? null,
      unitNetKg: unit,
    }
  })

  let pallets: PackingListPallet[]
  if (input.palletsOverride) {
    pallets = input.palletsOverride
  } else {
    pallets = []
    let n = input.firstPalletNumber
    for (const p of input.products) {
      const unit = unitNetKgFor(p.model, p.hasMesh ?? false)
      for (const load of palletLoads(p.quantity, p.packSize)) {
        const net = unit === null ? 0 : netKg(unit, load)
        pallets.push({
          ref: palletRef(input.palletMonth, n),
          // Their wording, which names the model and the count on the pallet.
          description: `Acoustic barriers (${p.model} = ${load} pcs)`,
          packingSize: p.packingSize ?? DEFAULT_PACKING_SIZE,
          netKg: net,
          grossKg: unit === null ? 0 : grossKg(net, false),
          loose: false,
        })
        n += 1
      }
    }
  }

  const totalNetKg = round1(pallets.reduce((a, p) => a + p.netKg, 0))
  const totalGrossKg = round1(pallets.reduce((a, p) => a + p.grossKg, 0))

  // The pallets that actually stand on the floor. A loose item is not a unit.
  const computed = pallets.filter((p) => !p.loose).length
  const units = input.signedPallets ?? computed
  if (input.signedPallets !== null && input.signedPallets !== computed) {
    warnings.push(
      `The signed specification says ${input.signedPallets} pallets and the products make ${computed}. The signed count is printed. Somebody has to say which is right before this ships.`,
    )
  }

  return {
    variant: input.variant,
    issuer: input.issuer,
    date: input.date,
    placeOfCollection: input.placeOfCollection,
    consignee: input.consignee,
    deliverTo: input.deliverTo,
    attention: {
      name: input.attention?.name ?? null,
      phone: input.attention?.phone ?? null,
      email: input.attention?.email ?? null,
    },
    incoterms: input.incoterms ?? null,
    lines,
    pallets,
    totalNetKg,
    totalGrossKg,
    units,
    comments: input.comments ?? null,
    weightsConfirmed: WEIGHTS_CONFIRMED,
    warnings,
  }
}

/**
 * The B copy of an A copy: the same pallets and weights on Group letterhead,
 * with Group's own consignee.
 *
 * Built from the A document rather than from the inputs again, because the two
 * copies disagreeing on a weight is the one failure this whole module exists to
 * prevent.
 */
export function asGroupCopy(
  a: PackingListDoc,
  group: { issuer: PackingListParty; consignee: PackingListParty },
): PackingListDoc {
  return { ...a, variant: 'B', issuer: group.issuer, consignee: group.consignee }
}
