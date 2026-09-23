import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The organisation is the outer scope of every module, and a scope that is
 * only a check is not a scope: it has to be in the query, and every write on a
 * record that belongs to an organisation has to ask whether the caller holds
 * it. This pins where each of those lives, so a refactor that drops one fails
 * here rather than in front of a rep who suddenly sees another region.
 *
 * Source grep, the house style of calls-write-guard and stock-write-guard.
 * Explicit file-by-file, because the pages differ in HOW they scope: a list
 * page resolves the organisation itself, a Quotes list does it inside the
 * action it calls, a record page checks the record.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

/** Pages that resolve the active organisation themselves and put it in the query. */
const LIST_PAGES: Record<string, string[]> = {
  // Both spellings of the organisation's depots go into the IN: the EURO sync
  // writes HubSpot's 'EU-France', the USA sync writes the code.
  'src/app/(dashboard)/invoicing/accepted/page.tsx': ['activeOrganisation(', ".in('depot_code', depotQueryValues(depots))"],
  'src/app/(dashboard)/invoicing/stage-queue.tsx': ['activeOrganisation(', ".eq('organisation_code', org)"],
  'src/app/(dashboard)/pricing/list/page.tsx': ['activeOrganisation(', 'getListPrices(currencies)'],
  'src/app/(dashboard)/pricing/contracts/page.tsx': ['activeOrganisation(', 'getContractPrices(currencies)'],
  'src/app/(dashboard)/pricing/caps/page.tsx': ['activeOrganisation(', 'organisation: org'],
  'src/app/(dashboard)/calls/log/page.tsx': ['activeOrganisation(', 'officesForOrg(org)'],
  'src/app/(dashboard)/calls/contacts/page.tsx': ['activeOrganisation(', 'officesForOrg(org)'],
  'src/app/(dashboard)/purchase-orders/page.tsx': ['activeOrganisation(', 'chainsForOrg(supabase, org)', '.or(filter)'],
  'src/app/(dashboard)/purchase-orders/approvals/page.tsx': ['activeOrganisation(', 'chainsForOrg(supabase, org)', '.or(filter)'],
  // Dean, 21 Sep 2026: in UK mode the raise page offers the UK depot, the UK
  // delivery address and the UK line items only.
  'src/app/(dashboard)/purchase-orders/create/page.tsx': ['activeOrganisation(', 'p.org === org', 'partiesForOrg(org)'],
  'src/app/(dashboard)/stock/finished/page.tsx': ['activeOrganisation(', 'loadFinishedBoard(new Date(), warehouses)'],
  'src/app/(dashboard)/stock/materials/page.tsx': ['activeOrganisation(', 'SRO_WAREHOUSE'],
  'src/app/(dashboard)/stock/movements/page.tsx': ['activeOrganisation(', 'loadMovements({ warehouses'],
  'src/app/(dashboard)/stock/reconciliation/page.tsx': ['activeOrganisation('],
  // Rebuilt on 22 Sep 2026 to read the live Cargo Partner shipments instead of
  // eleven hand-typed rows. The scope is the argument to loadCargoBoard: the
  // caller's depots, or null for the two organisations every container passes
  // through, and the loader puts it in the query with .in('destination_depot').
  'src/app/(dashboard)/transport/page.tsx': [
    'activeOrganisation(',
    'transportSeesAll(org) ? null : depotsForOrg(org)',
  ],
  'src/lib/cargo/store.ts': ["query.in('destination_depot', [...depots])"],
  'src/app/(dashboard)/invoices/page.tsx': ['activeOrganisation(', 'seller_entity_code.eq.', 'buyer_entity_code.eq.'],
}

/** Actions that scope a whole list on the caller's behalf. */
const LIST_ACTIONS: Record<string, string[]> = {
  'src/app/actions/hubspot/getDealsForBoard.ts': ['activeOrganisation(', 'pipelineForOrg(org)', "propertyName: 'pipeline', operator: 'EQ', value: pipelineId"],
  'src/app/actions/hubspot/getDeals.ts': ['activeOrganisation(', "propertyName: 'pipeline', operator: 'EQ', value: orgPipeline"],
}

/** Pages about one record: they check the record's own organisation. */
const RECORD_PAGES: Record<string, string[]> = {
  'src/app/(dashboard)/invoicing/[dealId]/page.tsx': ['holdsOrganisation(auth.profile.organisations, recordOrg)'],
  'src/app/(dashboard)/purchase-orders/[id]/page.tsx': ['poChainHeldBy(id, auth.profile.organisations)'],
  // A container bound for a depot the caller's organisation does not hold is
  // NOT FOUND, rather than hidden by a filter somebody could take off.
  'src/app/(dashboard)/transport/[spotId]/page.tsx': [
    'transportSeesAll(org)',
    'depotsForOrg(org)',
    'notFound()',
  ],
}

/** Writes on a record that belongs to an organisation, and the question each asks. */
const WRITE_GATES: Record<string, string> = {
  'src/app/(dashboard)/calls/actions.ts': 'officesForOrgs(auth.profile.organisations)',
  'src/app/actions/invoicing/open-invoice.ts': 'holdsOrganisation(gate.auth.profile.organisations, org)',
  'src/app/actions/invoicing/shared.ts': 'holdsOrganisation(heldBy',
  'src/app/actions/pricing/save-pricing.ts': 'currencyHeld(gate.auth, d.currency)',
  'src/app/actions/purchase-orders/create-po.ts': 'holdsOrganisation(profile.organisations, party.org)',
  'src/app/actions/purchase-orders/attachments.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/cargo-request.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/decide-po.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/fulfil-from-stock.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/raise-manufacturing-po.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/po-shipments.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/receive-po.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/set-po-stage.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/send-manufacturing-po.ts': 'poChainHeldBy(',
  'src/app/actions/purchase-orders/download-packing-list.ts': 'poChainHeldBy(parsed.data.poId, auth.profile.organisations)',
  'src/app/actions/purchase-orders/priced-document.ts': 'poChainHeldBy(',
  'src/app/actions/cargo/share-link.ts': 'shipmentInScope(',
  'src/app/(dashboard)/stock/actions.ts': 'warehouseHeld(',
  'src/app/(dashboard)/transport/actions.ts': 'depotsForOrgs(held).includes(d.depot_destination)',
  'src/app/actions/invoices/generate-commercial-invoice.ts': 'holdsOrganisation(held, cfg.seller)',
  'src/app/actions/invoices/edit-invoice-draft.ts': 'holdsOrganisation(held, header.seller_entity_code)',
  'src/app/actions/invoices/set-invoice-status.ts': 'holdsOrganisation(held, row.seller_entity_code)',
}

describe('every scoped list puts the organisation in its query', () => {
  for (const [file, needles] of Object.entries({ ...LIST_PAGES, ...LIST_ACTIONS })) {
    it(file, () => {
      const source = read(file)
      for (const needle of needles) expect(source, `${file} should contain ${needle}`).toContain(needle)
    })
  }
})

describe('every record page checks the record against what the caller holds', () => {
  for (const [file, needles] of Object.entries(RECORD_PAGES)) {
    it(file, () => {
      const source = read(file)
      for (const needle of needles) expect(source, `${file} should contain ${needle}`).toContain(needle)
    })
  }
})

describe('every write on an organisation-owned record asks whether the caller holds it', () => {
  for (const [file, needle] of Object.entries(WRITE_GATES)) {
    it(file, () => {
      expect(read(file), `${file} should contain ${needle}`).toContain(needle)
    })
  }

  it('every invoicing action that loads an invoice passes the organisations it may see', () => {
    // The loader answers "not found" for an invoice outside them. The one
    // bare call is a read for a page that has already checked the record.
    const source = read('src/app/actions/invoicing/attachments.ts')
    const bare = source.match(/loadInvoiceWithLines\([^,)]*\)/g) ?? []
    expect(bare.length).toBeLessThanOrEqual(1)
    for (const file of [
      'calculate-tax',
      'delivery-addresses',
      'email-invoice',
      'generate-invoice-pdf',
      'mark-sent',
      'preview-invoice',
      'record-taxjar',
      'save-coding',
      'save-draft',
      'save-reference',
      'send-to-xero',
    ]) {
      const s = read(`src/app/actions/invoicing/${file}.ts`)
      expect(s, file).toContain('gate.auth.profile.organisations)')
    }
  })
})

describe('the old single-field scoping is gone', () => {
  it('no page reads US_DEPOTS to decide what to list', () => {
    expect(read('src/app/(dashboard)/invoicing/accepted/page.tsx')).not.toContain('US_DEPOTS')
  })

  it('no page decides offices from a pipeline', () => {
    expect(read('src/lib/calls/offices.ts')).not.toContain('OFFICES_BY_PIPELINE')
    expect(read('src/lib/calls/offices.ts')).not.toContain('officesForViewer')
  })

  it('the board no longer takes a pipeline from the URL', () => {
    const board = read('src/app/(dashboard)/quotes/board/page.tsx')
    expect(board).not.toContain('PIPELINE_CONFIG')
    expect(board).not.toContain('pipelineParam')
  })
})
