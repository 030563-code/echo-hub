/**
 * Their "Packing size" column, read off what the specification already says.
 *
 * The manufacturing specification carries two free-text rows per model that
 * Bamida's OBJEDNÁVKOVÝ LIST has always had: "Pallet type" ("FYTO/210x140",
 * "210x140cm FYTO", "FYTO/označená", "označená") and "Pallet height" ("MAX
 * výška palety 235 cm !!!"). The packing list prints the same facts in its own
 * words: "210 x 140 cm / height 235 cm". Nothing else in either database holds
 * a pallet dimension, so this is a parser and not a table.
 *
 * WHAT IT WILL NOT DO. "FYTO" and "označená" are the pallet's treatment
 * (ISPM 15 heat treated) and its labelling, not its size, and half the models
 * say only that. A footprint that is not written down is not written down:
 * the parser returns the height alone and the caller says so, rather than
 * printing the H9 pallet's size against an H8 pallet because it is the only
 * size the Hub knows. Four-digit figures ("1200x800") are millimetres on a
 * different kind of pallet and are deliberately not read as centimetres.
 *
 * Pure, so the mapper and its tests need nothing from the database.
 */

/** Two or three digits either side of an x, not part of a longer number. */
const FOOTPRINT = /(?<!\d)(\d{2,3})\s*[x×X]\s*(\d{2,3})(?!\d)/
/** Two or three digits followed by cm, not part of a longer number. */
const HEIGHT = /(?<!\d)(\d{2,3})\s*cm(?![a-z])/i

/** "210 x 140 cm" from a pallet type row, or null when it names no size. */
export function palletFootprint(palletType: string | null | undefined): string | null {
  const m = FOOTPRINT.exec(String(palletType ?? ''))
  return m ? `${m[1]} x ${m[2]} cm` : null
}

/** "height 235 cm" from a pallet height row, or null when it names none. */
export function palletHeight(maxPalletHeight: string | null | undefined): string | null {
  const m = HEIGHT.exec(String(maxPalletHeight ?? ''))
  return m ? `height ${m[1]} cm` : null
}

export interface PackingSize {
  /** What the column prints, or null when neither row says anything usable. */
  text: string | null
  footprint: string | null
  height: string | null
}

/**
 * The printed packing size: "210 x 140 cm / height 235 cm", either half on its
 * own when that is all the specification says, or null when it says neither.
 */
export function packingSize(
  palletType: string | null | undefined,
  maxPalletHeight: string | null | undefined,
): PackingSize {
  const footprint = palletFootprint(palletType)
  const height = palletHeight(maxPalletHeight)
  const parts = [footprint, height].filter((p): p is string => p !== null)
  return { text: parts.length ? parts.join(' / ') : null, footprint, height }
}
