/**
 * Barriers per pallet, by manufacturing model code.
 *
 * ONE table, imported by both documents that count pallets. It used to be two
 * byte-identical copies, one in supplier-spec.ts for the -1 specification and
 * one in bamida-po.ts for the -3 priced order, each carrying a comment saying
 * they must never disagree. Nothing enforced that, and a divergence would have
 * made the two documents state different pallet counts for the same job with no
 * test failure and no error. The pallet count is also money on the -3: pallet
 * covers and metal frames are charged per pallet.
 *
 * Every figure here is read off a real issued order, not assumed:
 *
 *   H9        70   PO-00001413, "BALENIE: 9x70 ks" for 630 units
 *   H10       70   PO-00001421, "H10 2x 70 ks"
 *   H8        30   PO-00001421, "H8 2x30 ks"
 *   H10Japan  65   PO-00001398, "BALENIE: 8x65" for 520 units
 *
 * 🔴 H8 was 70 here until 17 Sep 2026 and that was wrong. A 60-unit H8 order
 * counted as one pallet instead of two, so the specification under-stated the
 * pallets and the priced order under-charged a pallet cover and a metal frame.
 *
 * Models with no entry fall through to DEFAULT_PACK. That covers H9Japan, which
 * has no order sheet of its own: it inherits 70 from the H9 it is built like,
 * which is what it resolved to before this table existed. Add it explicitly
 * only when a real Japan H9 order says otherwise.
 *
 * Keyed on the mfg model code (bom_weekly_snapshot.model_code), NOT the Hub SKU.
 */
export const PACK_SIZE: Record<string, number> = {
  H9: 70,
  H9W: 70,
  'H9X 2.1W': 70,
  'H9X 1.5W': 70,
  H10: 70,
  H10HercBlack: 70,
  H10Japan: 65,
  H8: 30,
}

export const DEFAULT_PACK = 70

/** Barriers per pallet for a model, falling back to the default. */
export function packSizeFor(modelCode: string | null | undefined): number {
  return PACK_SIZE[String(modelCode ?? '')] ?? DEFAULT_PACK
}

/** Whole pallets a quantity of a model makes, always rounded up. */
export function palletsFor(modelCode: string | null | undefined, quantity: number): number {
  return Math.ceil(quantity / packSizeFor(modelCode))
}
