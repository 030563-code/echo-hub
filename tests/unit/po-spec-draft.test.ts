import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  confirmButton,
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
  }

  it('prints the saved rows, not the standing model specification', () => {
    // 🔴 The whole point of storing the document: a confirmed sheet must not move
    // underneath the signature when somebody edits model_spec afterwards.
    const out = specFromDraft(draft(), header)
    expect(out.products[0].specRows).toEqual(draft().products[0].specRows)
    expect(out.products[0].spec).toBeNull()
    expect(out.products[0].sourceDocument).toBe('PO-00001413')
  })

  it('names nobody at Echo Barrier on the document', () => {
    // 🔴 Dean, 17 Sep 2026, on "Specification confirmed by Operations on 2026-09-17. Read from
    // template": "Please remove these on the client facing Document not needed at all." The
    // sign-off is ours; the factory only ever receives a confirmed document because the send
    // refuses an unconfirmed one.
    const out = JSON.stringify(specFromDraft(draft(), header))
    expect(out).not.toContain('Juraj')
    expect(out).not.toContain('approval')
    const pdf = readFileSync(join(process.cwd(), 'src/lib/supplier-spec-pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(pdf).not.toContain('Specification confirmed by')
    expect(pdf).not.toContain('SPECIFICATION NOT YET CONFIRMED')
    expect(pdf).not.toContain('Read from')
  })

  it('takes the number, date and addresses from the header and never from the draft', () => {
    const out = specFromDraft(draft(), header)
    expect(out.specNumber).toBe('EBSRO8001-1')
    expect(out.date).toBe('2026-09-17')
    expect(out.supplier.name).toBe('Supplier')
  })

  it('round-trips a generated document through the draft and back unchanged', () => {
    const built = specFromDraft(draft(), header)
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
    expect(exports).toEqual([
      'export async function loadSpecEditor',
      'export async function saveSpecDocument',
      'export async function confirmSpecDocument',
      'export async function resetSpecDocument',
    ])
    expect(actions).toContain("auth.capabilities.has('po.view')")
    expect(actions).toContain("auth.capabilities.has('bom.edit')")
    expect(actions).toContain('poChainHeldBy(poId, auth.profile.organisations)')
    // The two write exports share one gated path rather than each repeating it differently.
    expect((actions.match(/await gate\(/g) ?? []).length).toBe(3)
  })

  it('never trusts the client draft', () => {
    expect(actions).toContain('sanitiseDraft(rawDraft)')
    expect(store).toContain('draft: sanitiseDraft(draft)')
  })

  it('writes the content and the signature in ONE statement', () => {
    // 🔴 Two statements would leave a window where the words were saved and the
    // signature was not, or the reverse. Dean could not confirm at all until
    // this collapsed into one write.
    expect(store).toContain('confirmed_at: confirm ? now : null')
    expect(store).toContain('confirmed_by_uid: confirm ? actorUid : null')
    expect((store.match(/from\('po_spec_document'\)\s*\.upsert/g) ?? []).length).toBe(1)
  })

  it('withdraws the sign-off on an unsigned save, because the words changed', () => {
    // A signature belongs to the text that was read. `confirm` false writes null
    // into both columns, which is the withdrawal.
    expect(confirmButton({ confirmedAt: '2026-09-17T10:00:00Z', dirty: true, pending: false }).label)
      .toBe('Confirm specification')
    expect(store).toContain('An unsigned save CLEARS any existing sign-off')
  })

  it('does not make a signature depend on a prior save', () => {
    // 🔴 The bug Dean hit. Nothing may refuse a confirm for want of a saved row.
    expect(store).not.toContain('Save the specification before confirming it.')
    expect(store).not.toContain(".is('confirmed_at', null)")
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

describe('the Confirm button: an unsigned document can always be signed', () => {
  // 🔴 Dean, 17 Sep 2026: "I cant press confirm as it is greyed out. I need to edit something and
  // then it appears what if the first one is correct?" The first version required a save first,
  // which made the commonest case the one you could not do.
  const at = '2026-09-17T10:00:00Z'

  it('is pressable on a generated document nobody has touched', () => {
    expect(confirmButton({ confirmedAt: null, dirty: false, pending: false })).toEqual({
      disabled: false,
      label: 'Confirm specification',
      title: 'Saves this document and signs it off',
    })
  })

  it('is pressable on an edited document, without saving separately first', () => {
    expect(confirmButton({ confirmedAt: null, dirty: true, pending: false }).disabled).toBe(false)
  })

  it('is spent once the document is signed and nothing has changed', () => {
    const b = confirmButton({ confirmedAt: at, dirty: false, pending: false })
    expect(b.disabled).toBe(true)
    expect(b.label).toBe('Confirmed')
  })

  it('comes back the moment something changes, because that is a new document', () => {
    const b = confirmButton({ confirmedAt: at, dirty: true, pending: false })
    expect(b.disabled).toBe(false)
    expect(b.label).toBe('Confirm specification')
  })

  it('is held while a write is in flight, so a double click cannot sign twice', () => {
    expect(confirmButton({ confirmedAt: null, dirty: false, pending: true }).disabled).toBe(true)
  })
})

describe('guard: nothing reaches the factory on an unconfirmed specification', () => {
  // 🔴 Dean, 17 Sep 2026: "what if they click on Manufacturing PO (PDF) see the spec is good then
  // press on send to bamida without going into Edit Specification first to save it. Then does it
  // send with that red line?" It did. The factory would have downloaded a build sheet headed
  // SPECIFICATION NOT YET CONFIRMED, which is the one document the sign-off exists to prevent.
  const send = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/send-manufacturing-po.ts'),
    'utf8',
  )
  const card = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/purchase-orders/[id]/manufacturing-card.tsx'),
    'utf8',
  )
  const steps = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/purchase-orders/[id]/manufacturing-steps.tsx'),
    'utf8',
  )

  it('refuses on the SERVER, not only in the button', () => {
    // A 'use server' export is a public endpoint: a greyed button is not a gate.
    expect(send).toContain('const spec = await specDocumentStatus(poId)')
    expect(send).toContain('if (!spec.confirmedAt)')
    expect(send).toContain('Confirm the manufacturing specification before sending this order.')
  })

  it('refuses BEFORE it claims the send or contacts n8n', () => {
    // The claim is one-shot: refusing after it would burn the order's only send.
    const check = send.indexOf('const spec = await specDocumentStatus(poId)')
    const claim = send.indexOf('sent_at: new Date().toISOString()')
    expect(check).toBeGreaterThan(0)
    expect(claim).toBeGreaterThan(check)
  })

  it('tells the difference between saved-but-unconfirmed and never-opened', () => {
    expect(send).toContain('saved but not confirmed')
  })

  it('disables the button and says why, so nobody walks into the refusal', () => {
    expect(card).toContain('disabled={pending || !specConfirmed}')
    expect(card).toContain('Confirm the specification in step 1 above first.')
  })

  it('puts the steps in an order and locks the ones that are not reachable yet', () => {
    expect(steps).toContain('Check the specification')
    expect(steps).toContain('Download the documents')
    expect(steps).toContain('Send to the factory')
    expect(steps).toContain("state={sent ? 'done' : confirmed ? 'now' : 'locked'}")
  })

  it('explains itself on the page rather than only in a commit message', () => {
    // Dean: "There should really be more clarity on some of these things maybe some small
    // information icons we can hover over and it reveals how to use each page."
    const hint = readFileSync(join(process.cwd(), 'src/components/ui/info-hint.tsx'), 'utf8')
    // Reachable by keyboard, not only by hover.
    expect(hint).toContain('group-focus-within:opacity-100')
    expect(hint).toContain('<button')
    expect(hint).toContain('aria-label={label}')
    expect(steps).toContain('<InfoHint')
  })
})
