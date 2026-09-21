/**
 * Kilograms per barrier, and what a pallet adds, for the packing list.
 *
 * The Hub held NO weight of any kind before this file: not per barrier, not per
 * pallet, not net, not gross. The packing list is the first document that needs
 * one, and the freight booking is priced off the gross figure, so a wrong number
 * here costs money rather than looking untidy.
 *
 * Same shape and the same discipline as pack-size.ts: one table, keyed on the
 * manufacturing model code, every figure read off a real issued document rather
 * than assumed, and the document named beside it. The five packing lists read on
 * 21 Sep 2026 all reconcile to the arithmetic below, to the kilogram.
 *
 *   Jessup   11.09.2026  6x385 + 400 + 430 + 60 = 3,200 net / 3,600 gross
 *   Canada   17.07.2026  8x350                  = 2,800 net / 3,200 gross
 *   France   08.07.2026  4x325 + 4x385 + 166    = 3,006 net / 3,456 gross
 *   UK       10.08.2026  3x300 + 6x385          = 3,210 net / 3,660 gross
 *
 * 🔴 EVERY FIGURE IS UNCONFIRMED. They are read off Bamida's own packing lists,
 * not weighed, and `WEIGHTS_CONFIRMED` stays false until Juraj signs the table
 * off. The document prints that it is unconfirmed while the flag is false, the
 * same way the manufacturing specification does. Do not quietly flip it.
 *
 * 🔴 H9 IS BUILT TWO WAYS AND THEY WEIGH DIFFERENTLY. With a mesh back it is
 * 5.5 kg (France, UK, Jessup); without, 5.0 kg (Canada, "Green PVC front with
 * PU membrane back", no mesh). That is 175 kg on a 350-unit order, so the mesh
 * is an input and not a rounding. Where a model is only ever built one way,
 * meshAddsKg is absent and the flag is ignored.
 */

/**
 * What one pallet adds to the barriers standing on it: the pallet, its cover
 * and the metal frame. Constant at 50 kg across every document read, including
 * pallets of five cutting stations and pallets of seventy H9s, which is why it
 * is a tare and not a percentage.
 */
export const PALLET_TARE_KG = 50

/**
 * 🔴 Flip to true only when Juraj has confirmed the table. While it is false
 * every packing list built from these figures says so on its face.
 */
export const WEIGHTS_CONFIRMED = false

export interface PackWeight {
  /** Net kilograms of ONE barrier: no pallet, no cover, no frame. */
  unitNetKg: number
  /** What a mesh back adds per barrier, on the models built both ways. */
  meshAddsKg?: number
  /** The document this was read off, printed nowhere but kept for the next person. */
  source: string
}

/** Keyed on the mfg model code, exactly like PACK_SIZE in pack-size.ts. */
export const PACK_WEIGHT: Record<string, PackWeight> = {
  // 350 kg / 70 = 5.0 without mesh; 385 / 70 = 5.5 with.
  H9: { unitNetKg: 5.0, meshAddsKg: 0.5, source: 'PL-A CAN Ontario 17.07.2026 + PL-A USA Jessup 11.09.2026' },
  H9W: { unitNetKg: 5.0, meshAddsKg: 0.5, source: 'built as H9' },
  // 300 kg / 30.
  H8: { unitNetKg: 10.0, source: 'PL-A UK 10.08.2026' },
  // 325 kg / 30 = 10.8333. Their own "weight per pc" column rounds it to 10 kg,
  // but the pallet total is the figure that has to add up, so the exact value is
  // carried here and the printed per-piece figure is derived from it.
  'HT3,5': { unitNetKg: 325 / 30, source: 'PL-A France 08.07.2026' },
  // 300 kg / 30, the same pallet as H8.
  'ND RT-100': { unitNetKg: 10.0, source: 'PL-A UK 10.08.2026' },
  NDRT100: { unitNetKg: 10.0, source: 'PL-A UK 10.08.2026' },
  // Cutting stations travel as whole units, five to a pallet.
  'CS R10': { unitNetKg: 80.0, source: 'PL-A USA Jessup 11.09.2026' },
  'CS R10 Frame': { unitNetKg: 86.0, source: 'PL-A USA Jessup 11.09.2026' },
  CSCompact: { unitNetKg: 60.0, source: 'PL-A USA Jessup 11.09.2026, the CSC frame laid loose' },
}

/**
 * Net kilograms of one barrier of this model, or null when the table has no
 * entry for it.
 *
 * Null rather than a default on purpose. pack-size.ts can fall back to 70 per
 * pallet because being wrong there miscounts a pallet cover; being wrong here
 * puts a false weight on a customs document and a freight booking. The caller
 * reports the gap instead, the way the invoice generator reports a missing
 * transfer price rather than valuing the line at zero.
 */
export function unitNetKgFor(model: string | null | undefined, hasMesh = false): number | null {
  const row = PACK_WEIGHT[String(model ?? '')]
  if (!row) return null
  return row.unitNetKg + (hasMesh ? (row.meshAddsKg ?? 0) : 0)
}

/** Net kilograms of `units` barriers, before the pallet is counted. */
export function netKg(unitNetKg: number, units: number): number {
  return round1(unitNetKg * units)
}

/**
 * Gross kilograms of a pallet: its contents plus the tare.
 *
 * `loose` is the item laid straight into the container with no pallet under it,
 * which is how the single CSC frame travelled to Jessup. Its gross equals its
 * net because there is no pallet to weigh.
 */
export function grossKg(netForPallet: number, loose = false): number {
  return round1(loose ? netForPallet : netForPallet + PALLET_TARE_KG)
}

/**
 * Roman numerals for the pallet reference, which Bamida write as
 * `(2026/09/XVII)`. Only ever a running count of pallets in a month, so the
 * range that matters is small, but the loop is general rather than a lookup
 * table that would silently stop at whatever number somebody guessed.
 */
const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
]

export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1) return ''
  let left = n
  let out = ''
  for (const [value, numeral] of ROMAN) {
    while (left >= value) {
      out += numeral
      left -= value
    }
  }
  return out
}

/**
 * The printed pallet reference. `month` is a yyyy-mm string and `n` the pallet's
 * place in that month across ALL orders, not within this one: the July documents
 * run XV to XXIII on one shipment and XXIV to XXXI on the next, so the counter
 * is the factory's, not the order's.
 */
export function palletRef(month: string, n: number): string {
  return `(${month.replace('-', '/')}/${toRoman(n)})`
}

const round1 = (v: number) => Math.round(v * 10) / 10
