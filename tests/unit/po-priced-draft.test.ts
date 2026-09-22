import { describe, it, expect } from 'vitest'
import { buildBamidaPo } from '@/lib/bamida-po'
import type { SroPoBom, SroPoBomLine } from '@/lib/erp-types'
import {
  pricedDrift,
  pricedDriftSentence,
  pricedFromDraft,
  pricedTotals,
  sanitisePricedDraft,
  toPricedDraft,
  type PricedDraft,
} from '@/lib/po-priced-draft'

function line(over: Partial<SroPoBomLine> & { model_code: string; quantity: number }): SroPoBomLine {
  return {
    sku: `EB${over.model_code}NA`,
    product_name: `Echo Barrier ${over.model_code}`,
    has_bom: true,
    components: [],
    bamida_man_eur: 48.55,
    bamida_print_eur: 12.5,
    components_eur_unit: 0,
    bamida_total_line: 0,
    sro_total_line: 0,
    ...over,
  }
}

/** EBSRO8001-1 as Bamida price it: 350 H9, 5 V2, 5 cutting stations, packing as signed. */
const bom: SroPoBom = {
  id: 'sro-1',
  po_number: 'EBGRP8001',
  master_ref: 'MR-EBUSA8001',
  from_entity: 'EB-GROUP',
  to_entity: 'EB-SRO',
  approved_at: null,
  created_at: '2026-09-16T00:00:00Z',
  lines: [
    line({ model_code: 'H9', quantity: 350 }),
    line({ model_code: 'V2', quantity: 5, bamida_man_eur: 148, bamida_print_eur: 19.9 }),
    line({ model_code: 'CSCompact', quantity: 5, bamida_man_eur: 921, bamida_print_eur: 102 }),
  ],
  bamida_total: 0,
  sro_total: 0,
}
const generated = buildBamidaPo(bom, '2026-09-17', undefined, 'EBSRO8001-3', { pallets: 8, palletCovers: 8, metalFrames: 6 })

describe('the draft is the generated document, minus the header', () => {
  it('round-trips a generated document through the draft and back unchanged', () => {
    const back = pricedFromDraft(generated, toPricedDraft(generated))
    expect(back.lines).toEqual(generated.lines)
    expect([back.subtotal, back.tax, back.total]).toEqual([generated.subtotal, generated.tax, generated.total])
    expect(back.poNumber).toBe('EBSRO8001-3')
    expect(back.pallets).toBe(8)
  })

  it('works the totals out from the lines every time, never from anything stored', () => {
    const draft = toPricedDraft(generated)
    // Martin agrees a lower H9 price with Bamida.
    draft.lines[0] = { ...draft.lines[0], price: 45 }
    const printed = pricedFromDraft(generated, draft)
    expect(printed.lines[0].amount).toBe(350 * 45)
    expect(printed.subtotal).toBe(generated.subtotal! - 350 * (48.55 - 45))
    expect(pricedTotals(draft)).toEqual({ subtotal: printed.subtotal, tax: printed.tax, total: printed.total })
  })

  it('keeps the header from the base document and the lines from the draft', () => {
    const draft: PricedDraft = { lines: [{ code: 'TRANS', description: 'Transport to Košice', qty: 1, unit: 'EA', price: 250, taxRate: 0 }] }
    const printed = pricedFromDraft(generated, draft)
    expect(printed.supplier).toEqual(generated.supplier)
    expect(printed.buyer).toEqual(generated.buyer)
    expect(printed.date).toBe(generated.date)
    expect(printed.lines).toHaveLength(1)
    expect(printed.total).toBe(250)
    expect(printed.priced).toBe(true)
  })
})

describe('sanitisePricedDraft accepts what a browser sends and prints none of its mistakes', () => {
  it('keeps a well-formed draft intact', () => {
    const draft = toPricedDraft(generated)
    expect(sanitisePricedDraft(draft)).toEqual(draft)
  })

  it('drops a line with neither code nor description, and names a code-only line by its code', () => {
    const out = sanitisePricedDraft({ lines: [{ code: '', description: '' }, { code: 'X1', qty: 2, price: 3 }] })
    expect(out.lines).toEqual([{ code: 'X1', description: 'X1', qty: 2, unit: 'EA', price: 3, taxRate: 0 }])
  })

  it('refuses negatives and rubbish rather than printing them', () => {
    const out = sanitisePricedDraft({ lines: [{ code: 'A', description: 'a', qty: -5, price: -1, taxRate: 250 }, { code: 'B', description: 'b', qty: 'many', price: 'lots', taxRate: 'x' }] })
    expect(out.lines.map((l) => [l.qty, l.price, l.taxRate])).toEqual([
      [0, 0, 100],
      [0, 0, 0],
    ])
  })

  it('rounds a quantity to whole units and a price to cents', () => {
    const out = sanitisePricedDraft({ lines: [{ code: 'A', description: 'a', qty: 2.6, price: 1.006, taxRate: 20.123 }] })
    expect(out.lines[0]).toMatchObject({ qty: 3, price: 1.01, taxRate: 20.12 })
  })

  it('survives rubbish rather than throwing', () => {
    expect(sanitisePricedDraft(null).lines).toEqual([])
    expect(sanitisePricedDraft('nonsense').lines).toEqual([])
    expect(sanitisePricedDraft({ lines: 'nope' }).lines).toEqual([])
    expect(sanitisePricedDraft({ lines: [null, 42, 'x'] }).lines).toEqual([])
  })

  it('caps a field rather than letting a paste run to the printer', () => {
    const out = sanitisePricedDraft({ lines: [{ code: 'c'.repeat(500), description: 'd'.repeat(5000), unit: 'u'.repeat(50) }] })
    expect(out.lines[0].code).toHaveLength(60)
    expect(out.lines[0].description).toHaveLength(400)
    expect(out.lines[0].unit).toHaveLength(10)
  })

  it('keeps Slovak exactly as typed', () => {
    const out = sanitisePricedDraft({ lines: [{ code: 'DOPRAVA', description: 'Doprava Prešov, Košice, žltá páska' }] })
    expect(out.lines[0].description).toBe('Doprava Prešov, Košice, žltá páska')
  })
})

describe('pricedDrift reports what the order no longer agrees with', () => {
  const fresh = toPricedDraft(generated)

  it('finds nothing when they match, and nothing for a changed price', () => {
    expect(pricedDrift(fresh, fresh)).toEqual([])
    const repriced: PricedDraft = { lines: fresh.lines.map((l, i) => (i === 0 ? { ...l, price: 45 } : l)) }
    expect(pricedDrift(repriced, fresh)).toEqual([])
  })

  it('does not call a hand-added line drift', () => {
    const withTransport: PricedDraft = { lines: [...fresh.lines, { code: 'TRANS', description: 'Transport', qty: 1, unit: 'EA', price: 250, taxRate: 0 }] }
    expect(pricedDrift(withTransport, fresh)).toEqual([])
  })

  it('finds a quantity the order has changed, keyed by occurrence so the three PRISTD lines stay apart', () => {
    const changed = buildBamidaPo({ ...bom, lines: [line({ model_code: 'H9', quantity: 420 }), ...bom.lines.slice(1)] }, '2026-09-17', undefined, 'EBSRO8001-3', { pallets: 8, palletCovers: 8, metalFrames: 6 })
    const drift = pricedDrift(fresh, toPricedDraft(changed))
    expect(drift).toEqual([
      { kind: 'quantity', code: 'MANH9', was: 350, now: 420 },
      { kind: 'quantity', code: 'PRISTD', was: 350, now: 420 },
    ])
  })

  it('finds a product added to the order after the document was saved, and one taken off', () => {
    const more = buildBamidaPo({ ...bom, lines: [...bom.lines, line({ model_code: 'H8', quantity: 30 })] }, '2026-09-17', undefined, null, { pallets: 9, palletCovers: 9, metalFrames: 7 })
    expect(pricedDrift(fresh, toPricedDraft(more)).map((d) => d.kind)).toEqual(['missing', 'missing', 'quantity', 'quantity'])
    const fewer = buildBamidaPo({ ...bom, lines: bom.lines.slice(0, 1) }, '2026-09-17', undefined, null, { pallets: 5, palletCovers: 5, metalFrames: 5 })
    const kinds = pricedDrift(fresh, toPricedDraft(fewer)).map((d) => d.kind)
    expect(kinds.filter((k) => k === 'extra')).toHaveLength(4) // MANV2, PRISTD, MANCSCompact, PRISTD
  })

  it('says each one in words a person can act on', () => {
    expect(pricedDriftSentence({ kind: 'missing', code: 'MANH8', description: 'Bamida Manufacturing cost H8', qty: 30 })).toBe(
      'MANH8 (Bamida Manufacturing cost H8, 30) is on the order now but not on this document.',
    )
    expect(pricedDriftSentence({ kind: 'extra', code: 'MANV2', description: 'Bamida Manufacturing cost V2' })).toBe(
      'MANV2 (Bamida Manufacturing cost V2) is on this document but the order no longer produces it.',
    )
    expect(pricedDriftSentence({ kind: 'quantity', code: 'MANH9', was: 350, now: 420 })).toBe('MANH9 says 350 here and 420 on the order.')
  })
})
