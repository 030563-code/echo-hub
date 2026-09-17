import { describe, it, expect } from 'vitest'
import { PACK_SIZE, DEFAULT_PACK, packSizeFor, palletsFor } from '@/lib/pack-size'

/**
 * Every figure in PACK_SIZE is read off a real issued Bamida order. This file
 * pins each one to the document it came from, so a future edit has to argue
 * with the paperwork rather than with a guess.
 *
 * It also guards the reason the table was extracted: the -1 specification and
 * the -3 priced order used to hold byte-identical copies, and a divergence
 * would have made them state different pallet counts for the same job with no
 * test failure. The pallet count is money on the -3, which charges a pallet
 * cover and a metal frame per pallet.
 */
describe('pack sizes, each from a real order', () => {
  it('H9 is 70: PO-00001413 says BALENIE 9x70 ks for 630 units', () => {
    expect(packSizeFor('H9')).toBe(70)
    expect(palletsFor('H9', 630)).toBe(9)
  })

  it('H10 is 70: PO-00001421 says H10 2x 70 ks', () => {
    expect(packSizeFor('H10')).toBe(70)
    expect(palletsFor('H10', 140)).toBe(2)
  })

  it('H8 is 30, NOT 70: PO-00001421 says H8 2x30 ks', () => {
    // It was 70 until 17 Sep 2026. At 70 a 60-unit H8 order counted as one
    // pallet instead of two, so the priced order under-charged a pallet cover
    // and a metal frame, and the specification under-stated the pallets.
    expect(packSizeFor('H8')).toBe(30)
    expect(palletsFor('H8', 60)).toBe(2)
  })

  it('H10Japan is 65: PO-00001398 says BALENIE 8x65 for 520 units', () => {
    expect(packSizeFor('H10Japan')).toBe(65)
    expect(palletsFor('H10Japan', 520)).toBe(8)
  })

  it('Japan H10 does not inherit the standard H10 pack', () => {
    expect(packSizeFor('H10Japan')).not.toBe(packSizeFor('H10'))
  })

  it('a model with no entry falls back to the default, which is what H9Japan does', () => {
    // H9Japan has no order sheet of its own, so it inherits the 70 of the H9 it
    // is built like. Give it an explicit entry only when a real order says so.
    expect(PACK_SIZE.H9Japan).toBeUndefined()
    expect(packSizeFor('H9Japan')).toBe(DEFAULT_PACK)
    expect(packSizeFor('H9Japan')).toBe(packSizeFor('H9'))
  })

  it('an unknown, null or empty model is the default rather than a crash', () => {
    expect(packSizeFor('NoSuchModel')).toBe(DEFAULT_PACK)
    expect(packSizeFor(null)).toBe(DEFAULT_PACK)
    expect(packSizeFor(undefined)).toBe(DEFAULT_PACK)
    expect(packSizeFor('')).toBe(DEFAULT_PACK)
  })

  it('pallets always round up, so one unit over a boundary is another pallet', () => {
    expect(palletsFor('H9', 71)).toBe(2)
    expect(palletsFor('H8', 31)).toBe(2)
    expect(palletsFor('H10Japan', 66)).toBe(2)
  })
})

describe('the two documents share one table', () => {
  it('neither renderer defines its own pack sizes any more', async () => {
    const fs = await import('node:fs/promises')
    for (const file of ['src/lib/supplier-spec.ts', 'src/lib/bamida-po.ts']) {
      const source = await fs.readFile(file, 'utf8')
      // A local table would silently drift from the other document's.
      expect(source, `${file} must not redeclare PACK_SIZE`).not.toMatch(/const PACK_SIZE/)
      expect(source, `${file} must not redeclare DEFAULT_PACK`).not.toMatch(/const DEFAULT_PACK/)
      expect(source, `${file} must import from pack-size`).toMatch(/from '@\/lib\/pack-size'/)
    }
  })
})
