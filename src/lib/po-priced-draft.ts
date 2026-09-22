/**
 * The -3 priced (accounting) order as an editable document. Pure: no database, no session.
 *
 * Dean, 17 Sep 2026: "Juraj and Martin should really be able to edit all these PO's since theres
 * so many variables. It should be generated and prepopulated for him then he can edit and add
 * lines to these then it saves to the PO and prints properly." The -1 got that on 17 Sep; the -3
 * did not, and Martin hit it on 21 Sep: "is it possible to change purchase order with prices?"
 * Dean, 22 Sep: "where do they edit the priced PO?" Nowhere, until this.
 *
 * Same shape as po-spec-draft.ts. buildBamidaPo generates the lines from the bill of materials
 * (Bamida's unit prices from the weekly snapshot, the packaging from the signed -1); this is what
 * one order's lines look like once somebody has changed a price, added transport, or removed a
 * line, and what is stored is exactly what prints.
 *
 * 🔴 WHAT IS NOT STORED: the supplier and buyer blocks, the document number, the date and the
 * totals. The first four are ours and are put back on at print time. The totals are DERIVED from
 * the lines every time, so a saved total can never disagree with the lines under it.
 */

import type { BamidaPo, BamidaPoLine } from '@/lib/bamida-po'

export interface PricedDraftLine {
  code: string
  description: string
  qty: number
  unit: string
  /** Unit price in EUR, Bamida's price to s.r.o. */
  price: number
  /** Percent. Printing is 20, everything else 0 unless somebody says otherwise. */
  taxRate: number
}

export interface PricedDraft {
  lines: PricedDraftLine[]
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** Reduce a generated document to the editable half of it. */
export function toPricedDraft(po: BamidaPo): PricedDraft {
  return {
    lines: po.lines.map((l) => ({
      code: l.code,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      price: l.price ?? 0,
      taxRate: l.taxRate ?? 0,
    })),
  }
}

/**
 * Put the header back on a stored draft so it can be printed: the base document's supplier,
 * buyer, number, date and pallet count, with the saved lines and totals worked out from them.
 */
export function pricedFromDraft(base: BamidaPo, draft: PricedDraft): BamidaPo {
  const lines: BamidaPoLine[] = draft.lines.map((l) => ({
    code: l.code,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    price: round2(l.price),
    amount: round2(l.qty * l.price),
    taxRate: l.taxRate,
  }))
  const subtotal = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0))
  const tax = round2(lines.reduce((s, l) => s + ((l.amount ?? 0) * (l.taxRate ?? 0)) / 100, 0))
  return { ...base, lines, subtotal, tax, total: round2(subtotal + tax), priced: true }
}

/** The totals a draft prints, for the editor's footer. Same arithmetic as the printer. */
export function pricedTotals(draft: PricedDraft): { subtotal: number; tax: number; total: number } {
  const subtotal = round2(draft.lines.reduce((s, l) => s + round2(l.qty * l.price), 0))
  const tax = round2(draft.lines.reduce((s, l) => s + (round2(l.qty * l.price) * l.taxRate) / 100, 0))
  return { subtotal, tax, total: round2(subtotal + tax) }
}

// ---------------------------------------------------------------------------
// Validation: this crosses a trust boundary
// ---------------------------------------------------------------------------

const MAX_LINES = 100
const MAX_CODE = 60
const MAX_DESCRIPTION = 400
const MAX_UNIT = 10

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? round2(n) : 0
}

/**
 * Coerce whatever arrived into a draft we are willing to print. Nothing throws: a malformed line
 * is dropped, a malformed field becomes zero or empty, and the editor shows the result before
 * anybody saves it again.
 */
export function sanitisePricedDraft(input: unknown): PricedDraft {
  const raw = (input ?? {}) as Record<string, unknown>
  const lines = Array.isArray(raw.lines) ? raw.lines.slice(0, MAX_LINES) : []
  return {
    lines: lines
      .map((l) => {
        const row = (l ?? {}) as Record<string, unknown>
        const code = text(row.code, MAX_CODE)
        const description = text(row.description, MAX_DESCRIPTION)
        if (!code && !description) return null
        const qtyRaw = typeof row.qty === 'number' ? row.qty : Number(row.qty)
        const taxRaw = typeof row.taxRate === 'number' ? row.taxRate : Number(row.taxRate)
        return {
          code,
          description: description || code,
          // Whole units, never negative: the order is in barriers, covers and frames.
          qty: Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : 0,
          unit: text(row.unit, MAX_UNIT) || 'EA',
          price: money(row.price),
          taxRate: Number.isFinite(taxRaw) ? Math.min(100, Math.max(0, round2(taxRaw))) : 0,
        }
      })
      .filter((l): l is PricedDraftLine => l !== null),
  }
}

// ---------------------------------------------------------------------------
// Drift: the order moved after the draft was saved
// ---------------------------------------------------------------------------

export type PricedDrift =
  | { kind: 'missing'; code: string; description: string; qty: number }
  | { kind: 'extra'; code: string; description: string }
  | { kind: 'quantity'; code: string; was: number; now: number }

/** A generated document repeats a code (PRISTD once per product), so lines are keyed by occurrence. */
function keyed(lines: readonly PricedDraftLine[]): Map<string, PricedDraftLine> {
  const seen = new Map<string, number>()
  const out = new Map<string, PricedDraftLine>()
  for (const l of lines) {
    const n = (seen.get(l.code) ?? 0) + 1
    seen.set(l.code, n)
    out.set(`${l.code}#${n}`, l)
  }
  return out
}

/** The codes buildBamidaPo writes: MAN<model>, PRISTD, and the two packaging lines. */
const GENERATOR_CODE = /^(MAN|PRISTD$|Pallet COVERs$|1781$)/

/**
 * What the saved draft says that the order no longer does. Reported, never applied.
 *
 * A price change is an EDIT, not drift, so prices are never compared. A line the generator never
 * produces (transport, a one-off) is a hand-added line, not drift either. Drift is a generated
 * line that is missing, a generator line the order no longer produces (a product taken off it),
 * or a quantity the order has changed.
 */
export function pricedDrift(draft: PricedDraft, generated: PricedDraft): PricedDrift[] {
  const out: PricedDrift[] = []
  const saved = keyed(draft.lines)
  const fresh = keyed(generated.lines)
  const generatedCodes = new Set(generated.lines.map((l) => l.code))
  const generatorCode = (code: string) => generatedCodes.has(code) || GENERATOR_CODE.test(code)

  for (const [key, g] of fresh) {
    const mine = saved.get(key)
    if (!mine) out.push({ kind: 'missing', code: g.code, description: g.description, qty: g.qty })
    else if (mine.qty !== g.qty) out.push({ kind: 'quantity', code: g.code, was: mine.qty, now: g.qty })
  }
  for (const [key, s] of saved) {
    if (!fresh.has(key) && generatorCode(s.code)) {
      out.push({ kind: 'extra', code: s.code, description: s.description })
    }
  }
  return out
}

/** Plain words for one disagreement, used by the editor and the order page alike. */
export function pricedDriftSentence(d: PricedDrift): string {
  if (d.kind === 'missing') return `${d.code} (${d.description}, ${d.qty}) is on the order now but not on this document.`
  if (d.kind === 'extra') return `${d.code} (${d.description}) is on this document but the order no longer produces it.`
  return `${d.code} says ${d.was} here and ${d.now} on the order.`
}
