import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The -3 priced order editor: the migration, the store, the actions, the page, the printer and
 * the bill of materials tab must agree. Same genre as po-spec-draft.test.ts's guard block.
 *
 * Dean, 22 Sep 2026: "where do they edit the priced PO?"
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')
const UP = 'supabase/migrations/20260922100000_po_priced_document.sql'
const DOWN = 'supabase/migrations/rollback/20260922100000_po_priced_document.down.sql'

describe('the table', () => {
  const up = read(UP)
  it('mirrors po_spec_document: one row per order, service role only, updated_at kept honest', () => {
    expect(up).toContain('create table if not exists public.po_priced_document (')
    expect(up).toContain('po_id uuid primary key references public.purchase_orders(id) on delete cascade')
    expect(up).toMatch(/constraint po_priced_document_confirmed_together\s+check \(\(confirmed_at is null\) = \(confirmed_by_uid is null\)\)/)
    expect(up).toContain('alter table public.po_priced_document enable row level security')
    expect(up).toContain('revoke all on public.po_priced_document from public, anon, authenticated')
    expect(up).toContain('grant all on public.po_priced_document to service_role')
    expect(up).toMatch(/create trigger po_priced_document_touch\s+before update on public\.po_priced_document/)
  })
  it('has a rollback that drops what the up file creates', () => {
    const down = read(DOWN)
    expect(down).toContain('drop table if exists public.po_priced_document')
    expect(down).toContain('drop function if exists public.trg_po_priced_document_touch()')
  })
})

describe('the actions gate on the session, the capabilities and the chain', () => {
  const src = read('src/app/actions/purchase-orders/priced-document.ts')
  it('every export goes through the gate', () => {
    expect(src).toContain("if (!auth.capabilities.has('po.view'))")
    expect(src).toContain("if (!auth.capabilities.has('cost.view'))")
    expect(src).toContain("const canEdit = auth.capabilities.has('bom.edit')")
    expect(src).toContain("if (need === 'write' && !canEdit)")
    expect(src).toContain('poChainHeldBy(poId, auth.profile.organisations)')
    for (const fn of ['loadPricedEditor', 'savePricedDocument', 'confirmPricedDocument', 'resetPricedDocument']) {
      expect(src).toContain(`export async function ${fn}(`)
    }
  })
  it('never trusts the client draft and writes content and signature together', () => {
    expect(src).toContain('const draft = sanitisePricedDraft(rawDraft)')
    expect(read('src/lib/po-priced-store.ts')).toContain('confirmed_at: confirm ? now : null')
    expect(read('src/lib/po-priced-store.ts')).toContain('confirmed_by_uid: confirm ? actorUid : null')
  })
})

describe('the page and the card', () => {
  it('the page needs cost.view and refuses any leg but the manufacturing order', () => {
    const page = read('src/app/(dashboard)/purchase-orders/[id]/priced/page.tsx')
    expect(page).toContain("!auth.capabilities.has('cost.view')")
    expect(page).toContain("po.leg !== 'SRO_TO_SUPPLIER'")
    expect(page).toContain('poChainHeldBy(id, auth.profile.organisations)')
  })
  it('the editor saves to the order, not to page state', () => {
    expect(read('src/app/(dashboard)/purchase-orders/[id]/priced/priced-editor.tsx')).toContain('// page-state: none')
  })
  it('the steps card shows the priced step only to cost.view holders, and the order page passes it', () => {
    const steps = read('src/app/(dashboard)/purchase-orders/[id]/manufacturing-steps.tsx')
    expect(steps).toContain('{priced && (')
    expect(steps).toContain("href={`/purchase-orders/${poId}/priced`}")
    const page = read('src/app/(dashboard)/purchase-orders/[id]/page.tsx')
    expect(page).toContain('isManufacturingOrder && canViewCost ? await pricedDocumentStatus(id) : null')
  })
})

describe('what prints is what was saved', () => {
  it('the -3 overlays the saved lines on the generated document', () => {
    const src = read('src/lib/bamida-po-document.ts')
    expect(src).toContain('const saved = await readPricedDocument(poId)')
    expect(src).toContain('const document = saved ? pricedFromDraft(generated, saved.draft) : generated')
  })
  it('the generator the editor starts from prices the order the same way the -3 does', () => {
    const src = read('src/lib/bamida-po-document.ts')
    expect((src.match(/buildBamidaPo\(bom, documentDate, supplier, number, packing\)/g) ?? []).length).toBe(2)
    expect(src).toContain('export async function generatePricedOrder(')
  })
  it('the bill of materials tab shows the saved priced order too', () => {
    const bom = read('src/app/(dashboard)/bom/page.tsx')
    expect(bom).toContain('pricedDraftsBySroOrder(ids)')
    expect(bom).toContain('savedDraft ? pricedFromDraft(generated, savedDraft) : generated')
  })
  it('the store never imports the document module back', () => {
    expect(read('src/lib/po-priced-store.ts')).not.toMatch(/from '@\/lib\/bamida-po-document'/)
  })
})
