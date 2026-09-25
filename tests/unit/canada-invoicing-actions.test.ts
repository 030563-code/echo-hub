import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Canadian invoicing, Phase 1, through the real server actions.
 *
 * The session, next/cache, TaxJar, the Xero client, HubSpot's line descriptions
 * and the service-role client are fakes that record every call, every RPC and
 * every table write, so the tests can say what did NOT happen as well as what
 * did. Nothing here reaches a network. Every id, code, name and address is
 * invented.
 */

type Row = Record<string, unknown>

const db = vi.hoisted(() => ({
  organisations: ['EB-USA', 'EB-CANADA', 'EB-FRANCE'] as string[],
  invoice: null as Record<string, unknown> | null,
  lines: [] as Record<string, unknown>[],
  existingInvoice: null as { id: string } | null,
  deal: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  acceptedAt: '2026-09-20T10:00:00Z' as string | null,
  selects: [] as { table: string; cols: string }[],
  writes: [] as { table: string; op: string; payload: unknown }[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  /** Every .or() and every account_registry .eq(), so a test can say which rows a write was aimed at. */
  ors: [] as { table: string; expr: string }[],
  registryEqs: [] as [string, unknown][],
  /** The rows an account_registry update reports back: none unless a test says one matched. */
  registryUpdated: [] as Record<string, unknown>[],
}))

const hubspot = vi.hoisted(() => ({
  dealCompany: vi.fn(async (): Promise<string | null> => null),
}))

const taxjar = vi.hoisted(() => ({
  nexus: vi.fn(async (): Promise<string[]> => {
    throw new Error('offline in tests')
  }),
  calculate: vi.fn(async () => ({})),
  createOrder: vi.fn(async () => ({})),
}))

const xero = vi.hoisted(() => ({
  itemAccounts: vi.fn(async () => ({ ok: false as const, error: 'not reachable in tests' })),
  findContact: vi.fn(async () => ({ ok: true as const, data: null })),
  createDraft: vi.fn(async () => ({ ok: false as const, error: 'not reachable in tests' })),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: '00000000-0000-4000-8000-0000000000aa', email: 'reviewer@example.com' },
    profile: { organisations: db.organisations },
    capabilities: new Set(['invoicing.view', 'invoicing.manage']),
  }),
}))

vi.mock('@/lib/taxjar', () => ({
  taxjarNexusRegions: taxjar.nexus,
  taxjarCalculateTax: taxjar.calculate,
  taxjarCreateOrder: taxjar.createOrder,
  TaxJarError: class TaxJarError extends Error {},
  TaxJarConfigError: class TaxJarConfigError extends Error {},
}))

vi.mock('@/lib/xero-hub', () => ({
  xeroItemAccounts: xero.itemAccounts,
  xeroFindContact: xero.findContact,
  xeroCreateDraftInvoice: xero.createDraft,
}))

vi.mock('@/lib/customer-invoice/line-descriptions', () => ({
  fetchHubSpotLineDescriptions: vi.fn(async () => new Map()),
}))

vi.mock('@/lib/customer-invoice/deal-company', () => ({
  fetchDealCompanyId: hubspot.dealCompany,
}))

// A French invoice reads its quote's language from HubSpot on opening; that is
// covered by its own tests, and here it must not reach for the network.
vi.mock('@/lib/customer-invoice/document-language.server', () => ({
  setOpeningDocumentLanguage: vi.fn(async () => undefined),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args })
      const data =
        fn === 'create_customer_invoice'
          ? { id: '0d6c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d', holding_reference: 'TEST2026-00001' }
          : fn === 'save_customer_invoice'
            ? { status: 'draft', tax_invalidated: false }
            : fn === 'raise_customer_invoice'
              ? { invoice_number: 'EBUS26-9999', already_raised: false }
              : { ok: true }
      return { data, error: null }
    },
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let op = 'select'
      const single = () => {
        if (table === 'customer_invoices') return 'id' in filters ? db.invoice : db.existingInvoice
        if (table === 'deals_registry') return db.deal
        if (table === 'account_registry') return db.account
        return null
      }
      const list = () => {
        if (table === 'customer_invoice_lines') return db.lines
        if (table === 'deal_stage_history') {
          return db.acceptedAt ? [{ deal_id: db.deal?.hubspot_deal_id, changed_at: db.acceptedAt }] : []
        }
        return []
      }
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      Object.assign(builder, {
        select: (cols?: string) => {
          if (op === 'select') db.selects.push({ table, cols: String(cols ?? '') })
          return builder
        },
        eq: (col: string, value: unknown) => {
          filters[col] = value
          if (table === 'account_registry') db.registryEqs.push([col, value])
          return builder
        },
        or: (expr: string) => {
          db.ors.push({ table, expr })
          return builder
        },
        neq: chain,
        in: chain,
        gte: chain,
        order: chain,
        limit: chain,
        update: (payload: unknown) => {
          op = 'update'
          db.writes.push({ table, op, payload })
          return builder
        },
        insert: (payload: unknown) => {
          op = 'insert'
          db.writes.push({ table, op, payload })
          return builder
        },
        maybeSingle: async () => ({ data: single(), error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({
            data:
              op === 'select'
                ? list()
                : op === 'update' && table === 'account_registry'
                  ? db.registryUpdated
                  : null,
            error: null,
          }).then(resolve, reject),
      })
      return builder
    },
  }),
}))

import { calculateInvoiceTax } from '@/app/actions/invoicing/calculate-tax'
import { calculateInvoiceTaxXero } from '@/app/actions/invoicing/calculate-tax-fr'
import { fileInvoiceXeroDraft } from '@/app/actions/invoicing/file-invoice-fr'
import { sendOrderToTaxJar } from '@/app/actions/invoicing/record-taxjar'
import { saveInvoiceDraft } from '@/app/actions/invoicing/save-draft'
import { openInvoiceForDeal } from '@/app/actions/invoicing/open-invoice'

const INVOICE_ID = '7d0f3c1e-2b4a-4c5d-8e6f-0a1b2c3d4e5f'
const NOT_CONNECTED = 'Canadian tax is worked out by Xero. That step is not connected to the Hub yet.'

function invoiceRow(overrides: Row = {}): Row {
  return {
    id: INVOICE_ID,
    hubspot_deal_id: '990001',
    holding_reference: 'CAI2026-00001',
    organisation_code: 'EB-CANADA',
    status: 'draft',
    currency: 'CAD',
    invoice_number: null,
    invoice_date: null,
    due_date: null,
    payment_terms_label: null,
    billing_snapshot_at: null,
    hubspot_company_id: '880001',
    company_name: 'Invented Customer Ltd',
    taxjar_customer_id: 'QXZCAN001',
    customer_po_number: null,
    delivery_street: '12 Invented Road',
    delivery_city: 'Faketown',
    delivery_state: 'ON',
    delivery_zip: 'M9X 9Z9',
    delivery_country: 'CA',
    delivery_location: null,
    delivery_requested_by: null,
    is_collection: false,
    lines_hash: 'hash-a',
    idempotency_key: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
    xero_invoice_id: null,
    xero_draft_invoice_id: null,
    taxjar_response: null,
    ...overrides,
  }
}

function lineRow(overrides: Row = {}): Row {
  return {
    id: 'line-1',
    invoice_id: INVOICE_ID,
    line_key: 'L1',
    sort_order: 0,
    origin: 'hubspot',
    parent_line_key: null,
    hs_line_item_id: null,
    hs_product_id: null,
    sku: 'EBH9NA',
    xero_item_code: null,
    account_code: '9999',
    name: 'Echo Barrier H9',
    description: null,
    quantity: 5,
    unit_price: 100,
    discount_percentage: 0,
    line_total: 500,
    is_shipping: false,
    ship_from_depot: 'CA-HAM',
    ship_from_locked: false,
    tax_amount: null,
    taxable_amount: null,
    combined_tax_rate: null,
    tracking: [],
    tax_override: false,
    ...overrides,
  }
}

beforeEach(() => {
  db.organisations = ['EB-USA', 'EB-CANADA', 'EB-FRANCE']
  db.invoice = null
  db.lines = []
  db.existingInvoice = null
  db.deal = null
  db.account = null
  db.acceptedAt = '2026-09-20T10:00:00Z'
  db.selects = []
  db.writes = []
  db.rpcCalls = []
  db.ors = []
  db.registryEqs = []
  db.registryUpdated = []
  hubspot.dealCompany.mockClear()
  taxjar.nexus.mockClear()
  taxjar.calculate.mockClear()
  taxjar.createOrder.mockClear()
  xero.itemAccounts.mockClear()
  xero.findContact.mockClear()
  xero.createDraft.mockClear()
})

describe('🔴 the tax step refuses a Canadian invoice, and nothing leaves the Hub', () => {
  it('the TaxJar step answers with the Canadian sentence and never calls TaxJar', async () => {
    db.invoice = invoiceRow()
    db.lines = [lineRow()]
    const res = await calculateInvoiceTax({ invoiceId: INVOICE_ID })
    expect(res).toEqual({ success: false, error: NOT_CONNECTED })
    expect(taxjar.nexus).not.toHaveBeenCalled()
    expect(taxjar.calculate).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(db.rpcCalls).toEqual([])
  })

  it('the Xero draft step answers the same, before a draft is built or a row written', async () => {
    db.invoice = invoiceRow()
    db.lines = [lineRow()]
    const res = await calculateInvoiceTaxXero({ invoiceId: INVOICE_ID })
    expect(res).toEqual({ success: false, error: NOT_CONNECTED })
    expect(xero.createDraft).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(db.rpcCalls).toEqual([])
  })

  it('the numbering step takes no EBCA number', async () => {
    db.invoice = invoiceRow({ status: 'tax_calculated', xero_draft_invoice_id: 'invented-draft-id' })
    db.lines = [lineRow()]
    const res = await fileInvoiceXeroDraft({ invoiceId: INVOICE_ID })
    expect(res).toEqual({ success: false, error: NOT_CONNECTED })
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
    expect(xero.findContact).not.toHaveBeenCalled()
  })

  it('the TaxJar filing step files nothing for Canada, or for France', async () => {
    db.invoice = invoiceRow({ status: 'tax_calculated' })
    db.lines = [lineRow({ tax_amount: 0 })]
    expect(await sendOrderToTaxJar({ invoiceId: INVOICE_ID })).toEqual({ success: false, error: NOT_CONNECTED })

    db.invoice = invoiceRow({
      status: 'tax_calculated', organisation_code: 'EB-FRANCE', currency: 'EUR', delivery_country: 'FR',
      delivery_state: null, delivery_zip: '75999',
    })
    db.lines = [lineRow({ ship_from_depot: 'EU-FR', tax_amount: 0 })]
    expect(await sendOrderToTaxJar({ invoiceId: INVOICE_ID })).toEqual({
      success: false,
      error: 'France files nothing with TaxJar.',
    })

    expect(taxjar.createOrder).not.toHaveBeenCalled()
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('a US invoice still goes to TaxJar for its tax, and on to its number and filing', async () => {
    db.invoice = invoiceRow({
      organisation_code: 'EB-USA', currency: 'USD', delivery_country: 'US', delivery_state: 'TX',
      delivery_zip: '75999', holding_reference: 'USI2026-00001', taxjar_customer_id: 'QXZUSA001',
    })
    db.lines = [lineRow({ ship_from_depot: 'US-BAL' })]
    const res = await calculateInvoiceTax({ invoiceId: INVOICE_ID })
    // TaxJar is "offline" in this fake, so the answer is its outage message:
    // what matters is that the step got as far as asking.
    expect(res).toEqual({
      success: false,
      error: 'TaxJar could not be reached to check which states it collects for. Try again in a minute.',
    })
    expect(taxjar.nexus).toHaveBeenCalledTimes(1)

    db.invoice = { ...db.invoice, status: 'tax_calculated' }
    await sendOrderToTaxJar({ invoiceId: INVOICE_ID })
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['raise_customer_invoice'])
  })
})

function saveInput(header: Row, lines: Row[]) {
  return {
    invoiceId: INVOICE_ID,
    header: {
      invoice_date: null,
      due_date: null,
      customer_po_number: null,
      taxjar_customer_id: 'QXZCAN001',
      delivery_street: '12 Invented Road',
      delivery_city: 'Faketown',
      delivery_state: 'ON',
      delivery_zip: 'M9X 9Z9',
      delivery_location: null,
      delivery_requested_by: null,
      is_collection: false,
      ...header,
    },
    lines: lines.map((l, i) => ({
      line_key: String(l.line_key),
      sort_order: i,
      origin: l.origin as 'hubspot' | 'kit_split' | 'manual',
      parent_line_key: (l.parent_line_key as string | null) ?? null,
      hs_line_item_id: null,
      hs_product_id: null,
      sku: (l.sku as string | null) ?? null,
      account_code: '9999',
      xero_item_code: null,
      name: String(l.name),
      description: null,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      discount_percentage: 0,
      is_shipping: false,
      ship_from_depot: l.ship_from_depot as 'CA-HAM',
    })),
  }
}

describe('saving a Canadian draft', () => {
  const hook = lineRow({ line_key: 'L1-HKNA', origin: 'kit_split', parent_line_key: 'L1', sku: 'HKNA', name: 'Echo Barrier Hooks', quantity: 3, unit_price: 30 })
  const barrier = lineRow({ line_key: 'L2' })

  it('stores the province as its code, the postal code spaced, and keeps a kit at Hamilton', async () => {
    db.invoice = invoiceRow()
    db.lines = [hook, barrier]
    const res = await saveInvoiceDraft(saveInput({ delivery_state: 'on', delivery_zip: 'm9x9z9' }, [hook, barrier]))
    expect(res).toEqual({ success: true, status: 'draft', taxInvalidated: false })
    const call = db.rpcCalls.find((c) => c.fn === 'save_customer_invoice')!
    expect(call.args.p_header).toMatchObject({ delivery_state: 'ON', delivery_zip: 'M9X 9Z9' })
    const saved = call.args.p_lines as { line_key: string; ship_from_depot: string; ship_from_locked: boolean }[]
    expect(saved.map((l) => [l.line_key, l.ship_from_depot, l.ship_from_locked])).toEqual([
      ['L1-HKNA', 'CA-HAM', true],
      ['L2', 'CA-HAM', false],
    ])
  })

  it('refuses California\'s code, a US zip and a US depot on a Canadian invoice, in words', async () => {
    db.invoice = invoiceRow()
    db.lines = [barrier]
    expect(await saveInvoiceDraft(saveInput({ delivery_state: 'CA' }, [barrier]))).toEqual({
      success: false,
      error: 'Delivery province must be a 2-letter Canadian province or territory code.',
    })
    expect(await saveInvoiceDraft(saveInput({ delivery_zip: '20794' }, [barrier]))).toEqual({
      success: false,
      error: 'Delivery postal code must be in the form A1A 1A1.',
    })
    expect(await saveInvoiceDraft(saveInput({}, [{ ...barrier, ship_from_depot: 'US-BAL' }]))).toEqual({
      success: false,
      error: 'Canada invoices ship from CA-HAM; these lines ship from US-BAL.',
    })
    expect(db.rpcCalls).toEqual([])
  })

  it('leaves a US draft exactly as it was: state code, bare zip, kit at Baltimore', async () => {
    const usHook = { ...hook, ship_from_depot: 'US-BAL' }
    const usBarrier = { ...barrier, ship_from_depot: 'US-SBD' }
    db.invoice = invoiceRow({ organisation_code: 'EB-USA', currency: 'USD', delivery_country: 'US' })
    db.lines = [usHook, usBarrier]
    // The client claims the kit ships from San Bernardino; the stored line wins.
    const res = await saveInvoiceDraft(
      saveInput({ delivery_state: 'md', delivery_zip: '20794' }, [{ ...usHook, ship_from_depot: 'US-SBD' }, usBarrier]),
    )
    expect(res.success).toBe(true)
    const call = db.rpcCalls.find((c) => c.fn === 'save_customer_invoice')!
    expect(call.args.p_header).toMatchObject({ delivery_state: 'MD', delivery_zip: '20794' })
    expect((call.args.p_lines as { ship_from_depot: string }[]).map((l) => l.ship_from_depot)).toEqual(['US-BAL', 'US-SBD'])

    db.rpcCalls = []
    expect(await saveInvoiceDraft(saveInput({ delivery_state: 'ON' }, [usBarrier]))).toEqual({
      success: false,
      error: 'Delivery state must be a 2-letter US state code.',
    })
  })
})

describe('opening a Canadian invoice from an accepted deal', () => {
  const kit = { name: 'Fitting Kits', hs_product_id: '138783', quantity: 3, unit_price: 40 }
  const h9 = { name: 'Echo Barrier H9', sku: 'EBH9NA', quantity: 5, unit_price: 100 }

  function canadianDeal(overrides: Row = {}): Row {
    return {
      hubspot_deal_id: '990001',
      hubspot_company_id: '880001',
      deal_name: 'Invented Deal',
      deal_status: '1170409275',
      depot_code: 'CA-HAM',
      currency: 'CAD',
      line_items_raw: [kit, h9],
      quote_reference: 'Q-TEST-1',
      delivery_street: '12 Invented Road',
      delivery_city: 'Faketown',
      delivery_state: 'ON',
      delivery_zip: 'M9X 9Z9',
      is_collection: false,
      ...overrides,
    }
  }

  it('builds a CAD draft for Canada with the province, the Canadian account code as stored, and Hamilton kits', async () => {
    db.deal = canadianDeal()
    // The older of the two shapes, kept exactly as stored.
    db.account = { hubspot_company_name: 'Invented Customer Ltd', canada_xero_account_code: 'QXZCA01', usa_xero_account_code: 'QXZUSA001' }
    const res = await openInvoiceForDeal({ dealId: '990001' })
    expect(res).toEqual({ success: true, invoiceId: '0d6c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d', created: true })

    expect(db.selects.find((s) => s.table === 'account_registry')?.cols).toContain('canada_xero_account_code')
    const call = db.rpcCalls.find((c) => c.fn === 'create_customer_invoice')!
    expect(call.args.p_header).toMatchObject({
      organisation_code: 'EB-CANADA',
      currency: 'CAD',
      holding_prefix: 'CAI',
      delivery_country: 'CA',
      delivery_state: 'ON',
      delivery_zip: 'M9X 9Z9',
      taxjar_customer_id: 'QXZCA01',
      company_name: 'Invented Customer Ltd',
    })
    const lines = call.args.p_lines as { sku: string; ship_from_depot: string }[]
    expect(lines.map((l) => [l.sku, l.ship_from_depot])).toEqual([
      ['HKNA', 'CA-HAM'],
      ['BUNNA', 'CA-HAM'],
      ['EBH9NA', 'CA-HAM'],
    ])
  })

  it('refuses a Hamilton deal priced in US dollars, rather than invoicing it in CAD', async () => {
    db.deal = canadianDeal({ currency: 'USD' })
    const res = await openInvoiceForDeal({ dealId: '990001' })
    expect(res).toEqual({
      success: false,
      error:
        "This deal is in USD, and Canada invoices in CAD only. Correct the deal's currency in HubSpot if USD is wrong, " +
        'or give the deal the depot of the organisation that sells in USD.',
    })
    expect(db.rpcCalls).toEqual([])
  })

  it('refuses a Canadian deal to someone who does not hold Canada', async () => {
    db.organisations = ['EB-USA']
    db.deal = canadianDeal()
    expect(await openInvoiceForDeal({ dealId: '990001' })).toEqual({
      success: false,
      error: 'This deal belongs to an organisation you do not hold.',
    })
    expect(db.rpcCalls).toEqual([])
  })

  it('leaves a US draft exactly as it was', async () => {
    db.deal = canadianDeal({
      depot_code: 'US-BAL', currency: 'USD', delivery_state: 'MD', delivery_zip: '20794', delivery_city: 'Faketown',
    })
    db.account = { hubspot_company_name: 'Invented Customer Ltd', canada_xero_account_code: 'QXZCA01', usa_xero_account_code: 'QXZUSA001' }
    expect((await openInvoiceForDeal({ dealId: '990001' })).success).toBe(true)
    const call = db.rpcCalls.find((c) => c.fn === 'create_customer_invoice')!
    expect(call.args.p_header).toMatchObject({
      organisation_code: 'EB-USA',
      currency: 'USD',
      holding_prefix: 'USI',
      delivery_country: 'US',
      delivery_state: 'MD',
      delivery_zip: '20794',
      taxjar_customer_id: 'QXZUSA001',
    })
    expect((call.args.p_lines as { ship_from_depot: string }[]).map((l) => l.ship_from_depot)).toEqual(['US-BAL', 'US-BAL', 'US-BAL'])
  })

  it('still refuses a US deal in CAD with the words it always used', async () => {
    db.deal = canadianDeal({ depot_code: 'US-BAL', currency: 'CAD', delivery_state: 'MD', delivery_zip: '20794' })
    expect(await openInvoiceForDeal({ dealId: '990001' })).toEqual({
      success: false,
      error:
        'This deal is in CAD. US invoicing is USD only, because the TaxJar and Xero flow behind it is a US sales-tax flow. ' +
        "Invoice a CAD deal through the Canadian process instead, or correct the deal's currency in HubSpot if CAD is wrong.",
    })
  })
})

describe('a French invoice, its company and its Xero account number', () => {
  const frenchInvoice = (overrides: Row = {}) =>
    invoiceRow({
      organisation_code: 'EB-FRANCE',
      currency: 'EUR',
      holding_reference: 'FRI2026-00001',
      status: 'tax_calculated',
      xero_draft_invoice_id: 'invented-draft-id',
      taxjar_customer_id: 'QXZFRA001',
      delivery_country: 'FR',
      delivery_state: null,
      delivery_zip: '75999',
      ...overrides,
    })
  const events = () =>
    db.writes.filter((w) => w.table === 'customer_invoice_events').map((w) => (w.payload as Row).event)

  it('numbering keeps the account number on a company that had none', async () => {
    db.invoice = frenchInvoice()
    db.lines = [lineRow({ ship_from_depot: 'EU-FR', tax_amount: 0 })]
    db.registryUpdated = [{ hubspot_company_id: 880001 }]
    expect((await fileInvoiceXeroDraft({ invoiceId: INVOICE_ID })).success).toBe(true)

    expect(db.writes.find((w) => w.table === 'account_registry')).toMatchObject({
      op: 'update',
      payload: { france_xero_account_code: 'QXZFRA001' },
    })
    // Aimed at this company, and only while its French code is still empty.
    expect(db.registryEqs).toContainEqual(['hubspot_company_id', 880001])
    expect(db.ors).toContainEqual({
      table: 'account_registry',
      expr: 'france_xero_account_code.is.null,france_xero_account_code.eq.',
    })
    expect(events()).toEqual(['numbered', 'account_number_remembered'])
  })

  it('a company that already has a code keeps it, and nothing is logged as remembered', async () => {
    db.invoice = frenchInvoice()
    db.lines = [lineRow({ ship_from_depot: 'EU-FR', tax_amount: 0 })]
    // The "still empty" filter matches no row.
    db.registryUpdated = []
    expect((await fileInvoiceXeroDraft({ invoiceId: INVOICE_ID })).success).toBe(true)
    expect(events()).toEqual(['numbered'])
  })

  it('an invoice with no company, or no account number, writes nothing to the registry', async () => {
    db.lines = [lineRow({ ship_from_depot: 'EU-FR', tax_amount: 0 })]
    db.invoice = frenchInvoice({ hubspot_company_id: null })
    expect((await fileInvoiceXeroDraft({ invoiceId: INVOICE_ID })).success).toBe(true)
    db.invoice = frenchInvoice({ taxjar_customer_id: null })
    expect((await fileInvoiceXeroDraft({ invoiceId: INVOICE_ID })).success).toBe(true)
    expect(db.writes.filter((w) => w.table === 'account_registry')).toEqual([])
  })

  function frenchDeal(overrides: Row = {}): Row {
    return {
      hubspot_deal_id: '990001',
      hubspot_company_id: null,
      deal_name: 'Invented French Deal',
      deal_status: '1170409275',
      depot_code: 'EU-France',
      currency: 'USD',
      line_items_raw: [{ name: 'Echo Barrier H9', sku: 'EBH9', quantity: 5, unit_price: 100 }],
      quote_reference: 'Q-TEST-2',
      delivery_street: '1 Rue Inventee',
      delivery_city: 'Villefausse',
      delivery_state: null,
      delivery_zip: '75999',
      is_collection: false,
      ...overrides,
    }
  }

  it('a deal the registry holds no company for takes its primary company from HubSpot', async () => {
    db.deal = frenchDeal()
    hubspot.dealCompany.mockResolvedValueOnce('880002')
    db.account = { hubspot_company_name: 'Invented Client SAS', france_xero_account_code: 'QXZFRA002' }
    expect(await openInvoiceForDeal({ dealId: '990001' })).toMatchObject({ success: true, created: true })

    expect(hubspot.dealCompany).toHaveBeenCalledWith('990001')
    expect(db.registryEqs).toContainEqual(['hubspot_company_id', 880002])
    expect(db.rpcCalls.find((c) => c.fn === 'create_customer_invoice')!.args.p_header).toMatchObject({
      organisation_code: 'EB-FRANCE',
      hubspot_company_id: '880002',
      company_name: 'Invented Client SAS',
      taxjar_customer_id: 'QXZFRA002',
    })
  })

  it('a company the registry does hold wins, and HubSpot is not asked', async () => {
    db.deal = frenchDeal({ hubspot_company_id: '880001' })
    db.account = { hubspot_company_name: 'Invented Customer SAS', france_xero_account_code: 'QXZFRA001' }
    expect((await openInvoiceForDeal({ dealId: '990001' })).success).toBe(true)
    expect(hubspot.dealCompany).not.toHaveBeenCalled()
    expect(db.rpcCalls.find((c) => c.fn === 'create_customer_invoice')!.args.p_header).toMatchObject({
      hubspot_company_id: '880001',
      taxjar_customer_id: 'QXZFRA001',
    })
  })

  it('with no company anywhere the draft still opens, without an account number', async () => {
    db.deal = frenchDeal()
    expect((await openInvoiceForDeal({ dealId: '990001' })).success).toBe(true)
    expect(db.selects.some((s) => s.table === 'account_registry')).toBe(false)
    expect(db.rpcCalls.find((c) => c.fn === 'create_customer_invoice')!.args.p_header).toMatchObject({
      hubspot_company_id: null,
      taxjar_customer_id: null,
      company_name: 'Invented French Deal',
    })
  })
})
