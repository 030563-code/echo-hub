import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sanitiseDraft,
  specDrift,
  specFromDraft,
  toSpecDraft,
  driftSentence,
  type SpecDraft,
} from '@/lib/po-spec-draft'
import type { SupplierSpec } from '@/lib/supplier-spec'

function draft(over: Partial<SpecDraft> = {}): SpecDraft {
  return {
    destination: 'Echo Barrier USA',
    products: [
      {
        model: 'H9',
        name: 'Echo Barrier H9',
        quantity: 630,
        packSize: 70,
        pallets: 9,
        materials: [{ code: 'SK-PVC', description: 'PVC Mehler', perUnit: 2.4, total: 1512 }],
        specRows: [{ label: 'Goretex', value: 'PC350FR Grade 6 / Čierna' }],
        bullets: ['scanovanie datatagov'],
        sourceDocument: 'PO-00001413',
      },
    ],
    packing: { pallets: 9, palletCovers: 9, metalFrames: 9 },
    ...over,
  }
}

describe('sanitiseDraft accepts what a browser sends and prints none of its mistakes', () => {
  it('keeps a well-formed draft intact', () => {
    expect(sanitiseDraft(draft())).toEqual(draft())
  })

  it('derives the material total from the quantity rather than trusting it', () => {
    // 🔴 A total that disagrees with per-barrier times quantity is a picking list
    // that sends the wrong amount of fabric to the floor.
    const out = sanitiseDraft(
      draft({
        products: [{ ...draft().products[0], quantity: 100, materials: [
          { code: 'SK-PVC', description: 'PVC', perUnit: 2.4, total: 999999 },
        ] }],
      }),
    )
    expect(out.products[0].materials[0].total).toBe(240)
  })

  it('derives the pallet count too, because the covers are ordered against it', () => {
    const out = sanitiseDraft(
      draft({ products: [{ ...draft().products[0], quantity: 141, packSize: 70, pallets: 1 }] }),
    )
    expect(out.products[0].pallets).toBe(3)
  })

  it('drops a specification row with a label and no value', () => {
    // An empty requirement on a factory sheet reads as "none", not as "not filled in".
    const out = sanitiseDraft(
      draft({
        products: [{ ...draft().products[0], specRows: [
          { label: 'Mesh', value: '' },
          { label: 'Goretex', value: 'PC350FR' },
        ] }],
      }),
    )
    expect(out.products[0].specRows).toEqual([{ label: 'Goretex', value: 'PC350FR' }])
  })

  it('drops a product with no model, since nothing could tie it to the order', () => {
    const out = sanitiseDraft(draft({ products: [{ ...draft().products[0], model: '  ' }] }))
    expect(out.products).toEqual([])
  })

  it('survives rubbish rather than throwing, because a partial document beats a 500', () => {
    expect(() => sanitiseDraft(null)).not.toThrow()
    expect(() => sanitiseDraft('nonsense')).not.toThrow()
    expect(() => sanitiseDraft({ products: 'not an array', packing: 7 })).not.toThrow()
    expect(sanitiseDraft(null)).toEqual({
      destination: null,
      products: [],
      packing: { pallets: 0, palletCovers: 0, metalFrames: 0 },
    })
  })

  it('refuses a negative quantity instead of printing one', () => {
    const out = sanitiseDraft(draft({ products: [{ ...draft().products[0], quantity: -5 }] }))
    expect(out.products[0].quantity).toBe(0)
    expect(out.products[0].pallets).toBe(0)
  })

  it('caps a field rather than letting a paste run to the printer', () => {
    const long = 'x'.repeat(9000)
    const out = sanitiseDraft(
      draft({ products: [{ ...draft().products[0], bullets: [long] }] }),
    )
    expect(out.products[0].bullets[0].length).toBe(2000)
  })

  it('keeps Slovak exactly as typed', () => {
    const value = 'obojstranná lepiaca páska podľa štandardov, označovanie, poslať'
    const out = sanitiseDraft(
      draft({ products: [{ ...draft().products[0], bullets: [value] }] }),
    )
    expect(out.products[0].bullets[0]).toBe(value)
  })
})

describe('specDrift reports what the order no longer agrees with', () => {
  const generated = draft()

  it('finds nothing when they match', () => {
    expect(specDrift(draft(), generated)).toEqual([])
  })

  it('finds a quantity the order has changed', () => {
    const saved = draft({ products: [{ ...draft().products[0], quantity: 400 }] })
    expect(specDrift(saved, generated)).toEqual([
      { kind: 'quantity', model: 'H9', was: 400, now: 630 },
    ])
  })

  it('finds a product added to the order after the document was saved', () => {
    const fresh = draft({
      products: [...draft().products, { ...draft().products[0], model: 'H8', quantity: 210 }],
    })
    expect(specDrift(draft(), fresh)).toEqual([{ kind: 'missing', model: 'H8', quantity: 210 }])
  })

  it('finds a product taken off the order', () => {
    expect(specDrift(draft(), draft({ products: [] }))).toEqual([{ kind: 'extra', model: 'H9' }])
  })

  it('says each one in words a person can act on', () => {
    expect(driftSentence({ kind: 'quantity', model: 'H9', was: 400, now: 630 })).toContain('400')
    expect(driftSentence({ kind: 'missing', model: 'H8', quantity: 210 })).toContain('on the order')
    expect(driftSentence({ kind: 'extra', model: 'H8' })).toContain('no longer on the order')
  })
})

describe('specFromDraft puts the header back on for printing', () => {
  const header = {
    specNumber: 'EBSRO8001-1',
    date: '2026-09-17',
    supplier: { name: 'Supplier', address: ['Somewhere'], taxNumber: 'SK1' },
    buyer: { name: 'Buyer', address: ['Elsewhere'], taxNumber: 'SK2' },
    printing: 'Standard',
    approval: { at: '2026-09-17', by: 'Juraj Ziak' },
  }

  it('prints the saved rows, not the standing model specification', () => {
    // 🔴 The whole point of storing the document: a confirmed sheet must not move
    // underneath the signature when somebody edits model_spec afterwards.
    const out = specFromDraft(draft(), header)
    expect(out.products[0].specRows).toEqual(draft().products[0].specRows)
    expect(out.products[0].spec).toBeNull()
    expect(out.products[0].sourceDocument).toBe('PO-00001413')
  })

  it('carries the sign-off onto the document', () => {
    expect(specFromDraft(draft(), header).approval).toEqual({ at: '2026-09-17', by: 'Juraj Ziak' })
  })

  it('takes the number, date and addresses from the header and never from the draft', () => {
    const out = specFromDraft(draft(), header)
    expect(out.specNumber).toBe('EBSRO8001-1')
    expect(out.date).toBe('2026-09-17')
    expect(out.supplier.name).toBe('Supplier')
  })

  it('round-trips a generated document through the draft and back unchanged', () => {
    const built = specFromDraft(draft(), { ...header, approval: null })
    expect(toSpecDraft(built as SupplierSpec)).toEqual(draft())
  })
})

describe('guard: the specification cannot be edited or signed by the wrong person', () => {
  const actions = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/spec-document.ts'),
    'utf8',
  )
  const store = readFileSync(join(process.cwd(), 'src/lib/po-spec-store.ts'), 'utf8')

  it('gates every export on the session, a capability and the chain', () => {
    // Every export of a 'use server' file is a public endpoint.
    const exports = actions.match(/export async function (\w+)/g) ?? []
    expect(exports).toHaveLength(4)
    expect(actions).toContain("auth.capabilities.has('po.view')")
    expect(actions).toContain("auth.capabilities.has('bom.edit')")
    expect(actions).toContain('poChainHeldBy(poId, auth.profile.organisations)')
    // Each export goes through the one gate rather than repeating it differently.
    expect((actions.match(/await gate\(/g) ?? []).length).toBe(4)
  })

  it('never trusts the client draft', () => {
    expect(actions).toContain('sanitiseDraft(input.draft)')
    expect(store).toContain('draft: sanitiseDraft(draft)')
  })

  it('withdraws the sign-off when the words change', () => {
    // 🔴 A signature belongs to the text that was read. Saving an edit must not
    // leave a name printed against wording that person never saw.
    expect(store).toMatch(/saveSpecDraft[\s\S]*?confirmed_at: null,\s*\n\s*confirmed_by_uid: null,/)
  })

  it('confirms once and only once', () => {
    expect(store).toContain(".is('confirmed_at', null)")
  })

  it('refuses to confirm a document nobody saved', () => {
    expect(store).toContain('Save the specification before confirming it.')
  })

  it('never regenerates over an edit by itself', () => {
    // Drift is reported. Rebuilding is a person pressing a button that says what
    // it destroys, never a side effect of opening the page.
    expect(store).not.toContain('autoRegenerate')
    expect(actions).toContain('specDrift(document.draft, generated)')
  })

  it('keeps the table service-role only', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260917270000_po_spec_document.sql'),
      'utf8',
    )
    expect(migration).toContain('revoke all on public.po_spec_document from public, anon, authenticated')
    expect(migration).toContain('enable row level security')
    expect(migration).not.toMatch(/to authenticated/)
  })
})
