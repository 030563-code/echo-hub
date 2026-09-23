/**
 * The -1 manufacturing specification as an editable document. Pure: no database, no session.
 *
 * Dean, 17 Sep 2026: "Juraj and Martin should really be able to edit all these PO's since theres
 * so many variables. It should be generated and prepopulated for him then he can edit and add
 * lines to these then it saves to the PO and prints properly. That way nothing goes unsigned."
 *
 * model_spec holds the STANDING specification for a model. This is the specification for ONE
 * order: the standing one is what the editor starts from, and everything after the first save
 * belongs to the order. An order for Japan carries Japanese graphics and a hook pack; the next H10
 * order does not, and neither should have to overwrite the other.
 *
 * 🔴 WHY THE WHOLE DOCUMENT AND NOT A SET OF OVERRIDES. Whatever is stored is what prints. If only
 * the differences were stored, the printed sheet would be a join of a saved row and a live
 * model_spec that somebody could change afterwards, and the factory would be holding paper nobody
 * signed. A confirmed document has to be a thing that cannot move underneath the signature.
 */

import type {
  SupplierSpec,
  SupplierSpecMaterial,
  SupplierSpecPacking,
  SupplierSpecRow,
} from '@/lib/supplier-spec'
import type { BamidaSupplier } from '@/lib/bamida-po'

/**
 * One product on the document. `model` identifies it and is never edited: it is what ties the
 * block back to a line on the order, and to the priced -3 and the stock ledger.
 */
export interface SpecDraftProduct {
  model: string
  name: string
  quantity: number
  packSize: number
  pallets: number
  materials: SupplierSpecMaterial[]
  specRows: SupplierSpecRow[]
  bullets: string[]
  /** Which document the standing values were read from, printed in the confirmation line. */
  sourceDocument: string | null
}

/**
 * The editable half of the document, and the only half that is stored.
 *
 * The supplier and buyer blocks, the order number and the date are derived fresh at print time, so
 * a draft saved in June cannot print a stale address or last quarter's order number.
 */
export interface SpecDraft {
  destination: string | null
  products: SpecDraftProduct[]
  packing: SupplierSpecPacking
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** Reduce a freshly built SupplierSpec to the editable half of it. */
export function toSpecDraft(spec: SupplierSpec): SpecDraft {
  return {
    destination: spec.destination,
    products: spec.products.map((p) => ({
      model: p.model,
      name: p.name,
      quantity: p.quantity,
      packSize: p.packSize,
      pallets: p.pallets,
      materials: p.materials,
      specRows: p.specRows,
      bullets: p.bullets,
      // 🔴 Read from the product's OWN field, not from `spec`. specFromDraft
      // deliberately leaves `spec` null (the stored draft IS the specification),
      // so going via it would silently drop the provenance on a round trip and
      // the PDF would stop saying which document the values were read off.
      sourceDocument: p.sourceDocument ?? p.spec?.sourceDocument ?? null,
    })),
    packing: spec.packing,
  }
}

/** Put the header back on a stored draft so it can be printed. */
export function specFromDraft(
  draft: SpecDraft,
  header: {
    specNumber: string
    date: string
    supplier: BamidaSupplier
    buyer: SupplierSpec['buyer']
    printing: string
  },
): SupplierSpec {
  return {
    specNumber: header.specNumber,
    date: header.date,
    supplier: header.supplier,
    buyer: header.buyer,
    destination: draft.destination,
    products: draft.products.map((p) => ({
      model: p.model,
      name: p.name,
      quantity: p.quantity,
      packSize: p.packSize,
      pallets: p.pallets,
      materials: p.materials,
      specRows: p.specRows,
      bullets: p.bullets,
      sourceDocument: p.sourceDocument,
      // The stored draft IS the specification now. The standing model row is where it came from,
      // not what prints, so the printer is handed nothing that could disagree with the page.
      spec: null,
    })),
    packing: draft.packing,
    printing: header.printing,
  }
}

// ---------------------------------------------------------------------------
// Validation: this crosses a trust boundary
// ---------------------------------------------------------------------------

/** Longest a single field may be: room for the 127-character Lohmann note, not for a novel. */
const MAX_FIELD = 2000
const MAX_ROWS = 200
const MAX_PRODUCTS = 50

const text = (v: unknown, max = MAX_FIELD): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? round3(n) : fallback
}

/**
 * Coerce whatever arrived into a draft we are willing to print.
 *
 * Nothing here throws. A malformed row is dropped and a malformed field becomes empty, because a
 * specification that prints fifteen of its sixteen rows is worth more to the factory than a 500,
 * and the editor shows the result before anybody saves it again.
 */
export function sanitiseDraft(input: unknown): SpecDraft {
  const raw = (input ?? {}) as Record<string, unknown>
  const products = Array.isArray(raw.products) ? raw.products.slice(0, MAX_PRODUCTS) : []
  const packing = (raw.packing ?? {}) as Record<string, unknown>

  return {
    destination: text(raw.destination, 200) || null,
    products: products
      .map((p) => {
        const product = (p ?? {}) as Record<string, unknown>
        const model = text(product.model, 60)
        if (!model) return null
        const quantity = num(product.quantity)
        const packSize = Math.max(1, Math.round(num(product.packSize, 1)))
        return {
          model,
          name: text(product.name, 200) || model,
          quantity,
          packSize,
          // Derived, never trusted: the pallet count is what the pallet covers and the metal
          // frames are ordered against, and a hand-typed one that disagrees with the quantity is a
          // shipping problem nobody notices until the truck.
          pallets: quantity > 0 ? Math.ceil(quantity / packSize) : 0,
          materials: (Array.isArray(product.materials) ? product.materials : [])
            .slice(0, MAX_ROWS)
            .map((m) => {
              const row = (m ?? {}) as Record<string, unknown>
              const code = text(row.code, 60)
              const description = text(row.description, 400)
              if (!code && !description) return null
              const perUnit = num(row.perUnit)
              // The chosen colour of a fabric that comes in several (Juraj, 22 Sep 2026). Free
              // text at this boundary rather than checked against the options: an option
              // withdrawn after a document was signed must still print what was signed.
              const colour = text(row.colour, 60)
              return {
                code,
                description: description || code,
                perUnit,
                // Always derived. A total that disagrees with per-barrier times quantity is a
                // picking list that sends the wrong amount of fabric to the floor.
                total: round3(perUnit * quantity),
                ...(colour ? { colour } : {}),
              }
            })
            .filter((m): m is SupplierSpecMaterial => m !== null),
          specRows: (Array.isArray(product.specRows) ? product.specRows : [])
            .slice(0, MAX_ROWS)
            .map((r) => {
              const row = (r ?? {}) as Record<string, unknown>
              const label = text(row.label, 120)
              const value = text(row.value)
              // A label with no value prints as an empty requirement, which on a factory sheet
              // reads as "none" rather than as "not filled in yet".
              return label && value ? { label, value } : null
            })
            .filter((r): r is SupplierSpecRow => r !== null),
          bullets: (Array.isArray(product.bullets) ? product.bullets : [])
            .slice(0, MAX_ROWS)
            .map((b) => text(b))
            .filter(Boolean),
          sourceDocument: text(product.sourceDocument, 120) || null,
        }
      })
      .filter((p): p is SpecDraftProduct => p !== null),
    packing: {
      pallets: Math.round(num(packing.pallets)),
      palletCovers: Math.round(num(packing.palletCovers)),
      metalFrames: Math.round(num(packing.metalFrames)),
    },
  }
}

// ---------------------------------------------------------------------------
// Drift: the order moved after the draft was saved
// ---------------------------------------------------------------------------

export type SpecDrift =
  | { kind: 'missing'; model: string; quantity: number }
  | { kind: 'extra'; model: string }
  | { kind: 'quantity'; model: string; was: number; now: number }

/**
 * What the saved draft says that the order no longer does.
 *
 * Reported, never applied. Regenerating would be the easy answer and the wrong one: it would throw
 * away every hand edit, silently, on a document somebody may already have signed.
 */
export function specDrift(draft: SpecDraft, generated: SpecDraft): SpecDrift[] {
  const out: SpecDrift[] = []
  const saved = new Map(draft.products.map((p) => [p.model, p]))
  const fresh = new Map(generated.products.map((p) => [p.model, p]))

  for (const [model, p] of fresh) {
    const mine = saved.get(model)
    if (!mine) out.push({ kind: 'missing', model, quantity: p.quantity })
    else if (mine.quantity !== p.quantity)
      out.push({ kind: 'quantity', model, was: mine.quantity, now: p.quantity })
  }
  for (const model of saved.keys()) {
    if (!fresh.has(model)) out.push({ kind: 'extra', model })
  }
  return out
}

/** Plain words for one disagreement, used by the editor and the order page alike. */
export function driftSentence(d: SpecDrift): string {
  if (d.kind === 'missing') return `${d.model} is on the order (${d.quantity} units) but not on this document.`
  if (d.kind === 'extra') return `${d.model} is on this document but no longer on the order.`
  return `${d.model} says ${d.was} units here and ${d.now} on the order.`
}

// ---------------------------------------------------------------------------
// The Confirm button
// ---------------------------------------------------------------------------

/**
 * Whether the document can be signed right now, and what the button should say.
 *
 * 🔴 Pure, and tested, because getting this wrong is not cosmetic. Dean, 17 Sep 2026: "I cant
 * press confirm as it is greyed out. I need to edit something and then it appears what if the
 * first one is correct?"
 *
 * The first version required a save before a confirm, which made the COMMONEST case the one you
 * could not do: a generated document that is already right could only be signed by first making an
 * edit nobody wanted. The rule now is simply "an unsigned document can always be signed", and
 * confirming writes the content and the signature together.
 */
export function confirmButton(input: {
  confirmedAt: string | null
  dirty: boolean
  pending: boolean
}): { disabled: boolean; label: string; title: string } {
  const alreadySigned = Boolean(input.confirmedAt) && !input.dirty
  return {
    disabled: input.pending || alreadySigned,
    label: alreadySigned ? 'Confirmed' : 'Confirm specification',
    title: alreadySigned
      ? 'Already confirmed. Change something to confirm the new version.'
      : 'Saves this document and signs it off',
  }
}
