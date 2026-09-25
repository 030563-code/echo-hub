import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the invoice's language is stored: once when the draft is opened, and
 * again whenever the reviewer changes it on an invoice that is still editable.
 *
 * The session, next/cache and the service-role client are fakes. The client
 * records every write with the filters it carried, so a test can see not just
 * that the language was written but that the write was guarded by status.
 * Every id, company and address is invented.
 */

const db = vi.hoisted(() => ({
  capabilities: new Set<string>(['invoicing.manage']),
  organisations: ['EB-FRANCE', 'EB-USA'] as string[],
  invoice: null as Record<string, unknown> | null,
  lines: [] as Record<string, unknown>[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  writes: [] as { table: string; op: 'update' | 'insert'; payload: Record<string, unknown>; filters: [string, string, unknown][] }[],
  /** Whether a status-guarded update still finds its row. */
  updateMatches: true,
  updateError: null as { message: string } | null,
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: '00000000-0000-4000-8000-000000000007' },
    profile: { organisations: db.organisations },
    capabilities: db.capabilities,
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args })
      return { data: { status: 'draft', tax_invalidated: false }, error: null }
    },
    from(table: string) {
      let op: 'select' | 'update' | 'insert' = 'select'
      let payload: Record<string, unknown> = {}
      const filters: [string, string, unknown][] = []
      const result = () => {
        if (op === 'update') {
          db.writes.push({ table, op, payload, filters })
          if (db.updateError) return { data: null, error: db.updateError }
          return { data: db.updateMatches ? [{ id: 'row' }] : [], error: null }
        }
        if (op === 'insert') {
          db.writes.push({ table, op, payload, filters })
          return { data: null, error: null }
        }
        return { data: table === 'customer_invoice_lines' ? db.lines : [], error: null }
      }
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push(['eq', column, value])
          return builder
        },
        in: (column: string, value: unknown) => {
          filters.push(['in', column, value])
          return builder
        },
        order: () => builder,
        update: (p: Record<string, unknown>) => {
          op = 'update'
          payload = p
          return builder
        },
        insert: (p: Record<string, unknown>) => {
          op = 'insert'
          payload = p
          return builder
        },
        maybeSingle: async () => ({ data: table === 'customer_invoices' ? db.invoice : null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

import { saveInvoiceDraft } from '@/app/actions/invoicing/save-draft'
import { setOpeningDocumentLanguage } from '@/lib/customer-invoice/document-language.server'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'

const INVOICE_ID = '3c2b1a09-8f7e-4d6c-9b5a-4a3b2c1d0e9f'

const frenchDraft = (over: Record<string, unknown> = {}) => ({
  id: INVOICE_ID,
  hubspot_deal_id: '900000000010',
  organisation_code: 'EB-FRANCE',
  status: 'draft',
  document_language: 'fr',
  lines_hash: 'hash-before',
  ...over,
})

const LINE = {
  line_key: 'L1', sort_order: 0, origin: 'hubspot' as const, parent_line_key: null, hs_line_item_id: null,
  hs_product_id: null, sku: null, account_code: null, xero_item_code: null, name: 'Echo Barrier H10',
  description: null, quantity: 10, unit_price: 378, discount_percentage: 0, is_shipping: false,
  ship_from_depot: 'EU-FR' as const,
}

const header = (over: Record<string, unknown> = {}) => ({
  invoice_date: null, due_date: null, customer_po_number: null, taxjar_customer_id: null,
  delivery_street: '12 rue des Exemples', delivery_city: 'Lyon', delivery_state: null, delivery_zip: '69001',
  delivery_location: null, delivery_requested_by: null, is_collection: false,
  ...over,
})

const save = (h: Record<string, unknown>, lines = [LINE]) =>
  saveInvoiceDraft({ invoiceId: INVOICE_ID, header: h, lines } as unknown as Parameters<typeof saveInvoiceDraft>[0])

const invoiceUpdates = () => db.writes.filter((w) => w.table === 'customer_invoices' && w.op === 'update')
const events = () => db.writes.filter((w) => w.table === 'customer_invoice_events').map((w) => w.payload)

beforeEach(() => {
  db.capabilities = new Set(['invoicing.manage'])
  db.organisations = ['EB-FRANCE', 'EB-USA']
  db.invoice = frenchDraft()
  db.lines = [{ ...LINE, tax_amount: null }]
  db.rpcCalls = []
  db.writes = []
  db.updateMatches = true
  db.updateError = null
})

describe('changing the language in the editor', () => {
  it('stores the new language after the save, guarded by status, and logs the change', async () => {
    const res = await save(header({ document_language: 'es' }))
    expect(res).toEqual({ success: true, status: 'draft', taxInvalidated: false })
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['save_customer_invoice'])
    const [update] = invoiceUpdates()
    expect(update.payload).toEqual({ document_language: 'es' })
    expect(update.filters).toContainEqual(['eq', 'id', INVOICE_ID])
    expect(update.filters).toContainEqual(['in', 'status', ['draft', 'tax_calculated']])
    expect(events()).toContainEqual(
      expect.objectContaining({ invoice_id: INVOICE_ID, event: 'language_changed', payload: { from: 'fr', to: 'es' } }),
    )
  })

  it('is not a tax input, so changing it keeps the calculated tax', async () => {
    db.invoice = frenchDraft({ status: 'tax_calculated' })
    const first = await save(header({ document_language: 'fr' }))
    expect(first.success).toBe(true)
    const hashWithFrench = db.rpcCalls[0].args.p_new_hash
    db.rpcCalls = []
    await save(header({ document_language: 'es' }))
    expect(db.rpcCalls[0].args.p_new_hash).toBe(hashWithFrench)
  })

  it('writes nothing extra when the language did not change', async () => {
    await save(header({ document_language: 'fr' }))
    expect(invoiceUpdates()).toEqual([])
    expect(events().filter((e) => e.event === 'language_changed')).toEqual([])
  })

  it('leaves the stored language alone when a tab from before the choice posts without it', async () => {
    const res = await save(header())
    expect(res.success).toBe(true)
    expect(invoiceUpdates()).toEqual([])
  })

  it('refuses a French or Spanish USA invoice before anything is written', async () => {
    db.invoice = frenchDraft({ organisation_code: 'EB-USA', document_language: 'en' })
    const res = await save(
      header({ document_language: 'fr', delivery_state: 'CA', delivery_zip: '90001' }),
      [{ ...LINE, ship_from_depot: 'US-BAL' as never }],
    )
    expect(res.success).toBe(false)
    expect(res.success === false && res.error).toMatch(/English only/)
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('is frozen once the invoice is numbered, like every other field', async () => {
    db.invoice = frenchDraft({ status: 'filed' })
    const res = await save(header({ document_language: 'es' }))
    expect(res.success).toBe(false)
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('says so when the invoice moved on before the language was written', async () => {
    db.updateMatches = false
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await save(header({ document_language: 'es' }))
    expect(errors).toHaveBeenCalledWith('saveInvoiceDraft: the document language was not stored:', 'the invoice is no longer editable')
    errors.mockRestore()
    expect(res).toEqual({ success: false, error: 'The invoice was saved, but its language could not be changed. Save again.' })
    expect(events().filter((e) => e.event === 'language_changed')).toEqual([])
  })
})

/** HubSpot answering the two reads the default makes. */
function hubSpot(opts: { status?: number; quotes?: { id: string; hs_language: string; hs_status: string }[] }) {
  const calls: string[] = []
  const fetcher = async (url: string) => {
    calls.push(url)
    const status = opts.status ?? 200
    const reply = (body: unknown) => ({ ok: status < 400, status, json: async () => body })
    if (url.includes('/associations/quotes')) return reply({ results: (opts.quotes ?? []).map((q) => ({ toObjectId: q.id })) })
    return reply({
      results: (opts.quotes ?? []).map(({ id, ...properties }) => ({
        id,
        properties: { ...properties, hs_createdate: '2026-09-20T09:00:00Z' },
      })),
    })
  }
  return { fetcher: fetcher as unknown as Parameters<typeof setOpeningDocumentLanguage>[0]['fetcher'], calls }
}

describe('the language a draft opens in', () => {
  const open = (org: 'EB-FRANCE' | 'EB-USA', extra: Partial<Parameters<typeof setOpeningDocumentLanguage>[0]> = {}) =>
    setOpeningDocumentLanguage({
      invoiceId: INVOICE_ID,
      dealId: '900000000010',
      profile: invoicingProfile(org)!,
      actorUid: '00000000-0000-4000-8000-000000000007',
      ...extra,
    })

  it('a USA draft stays English: no HubSpot read, no write, no event', async () => {
    const hs = hubSpot({ quotes: [{ id: '5001', hs_language: 'fr', hs_status: 'APPROVAL_NOT_NEEDED' }] })
    expect(await open('EB-USA', { fetcher: hs.fetcher })).toBe('en')
    expect(hs.calls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('a French draft takes the language of the deal\'s quote, and records where it came from', async () => {
    const hs = hubSpot({ quotes: [{ id: '5001', hs_language: 'es', hs_status: 'APPROVAL_NOT_NEEDED' }] })
    expect(await open('EB-FRANCE', { fetcher: hs.fetcher })).toBe('es')
    const [update] = invoiceUpdates()
    expect(update.payload).toEqual({ document_language: 'es' })
    expect(update.filters).toContainEqual(['eq', 'id', INVOICE_ID])
    expect(update.filters).toContainEqual(['eq', 'status', 'draft'])
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: 'language_defaulted',
        payload: { language: 'es', source: 'quote', quote_id: '5001', hs_language: 'es' },
      }),
    )
  })

  it('a rebuild keeps the reviewer\'s language without asking HubSpot', async () => {
    const hs = hubSpot({ quotes: [{ id: '5001', hs_language: 'es', hs_status: 'APPROVAL_NOT_NEEDED' }] })
    expect(await open('EB-FRANCE', { fetcher: hs.fetcher, carriedOver: 'fr' })).toBe('fr')
    expect(hs.calls).toEqual([])
    expect(invoiceUpdates()[0].payload).toEqual({ document_language: 'fr' })
    expect(events()[0]).toMatchObject({ event: 'language_defaulted', payload: { language: 'fr', source: 'rebuilt' } })
  })

  it('English is the column default, so an English quote or no quote writes nothing but the reason', async () => {
    expect(await open('EB-FRANCE', { fetcher: hubSpot({ quotes: [] }).fetcher })).toBe('en')
    expect(invoiceUpdates()).toEqual([])
    expect(events()[0]).toMatchObject({ event: 'language_defaulted', payload: { language: 'en', source: 'no_quote' } })
  })

  it('HubSpot being down opens the draft in English and says why', async () => {
    expect(await open('EB-FRANCE', { fetcher: hubSpot({ status: 503 }).fetcher })).toBe('en')
    expect(invoiceUpdates()).toEqual([])
    expect(events()[0]).toMatchObject({
      event: 'language_defaulted',
      payload: { language: 'en', source: 'unreadable', read_error: 'quote associations answered 503' },
    })
  })

  it('a failed write leaves the draft in English and records it, rather than failing the open', async () => {
    db.updateError = { message: 'boom' }
    const hs = hubSpot({ quotes: [{ id: '5001', hs_language: 'fr', hs_status: 'APPROVAL_NOT_NEEDED' }] })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await open('EB-FRANCE', { fetcher: hs.fetcher })).toBe('en')
    errors.mockRestore()
    expect(events()[0]).toMatchObject({ payload: { language: 'en', source: 'quote', write_error: 'boom' } })
  })
})

describe('the wiring', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

  it('opening an invoice sets its language once the draft exists, passing on a rebuild\'s', () => {
    const src = read('src/app/actions/invoicing/open-invoice.ts')
    const created = src.indexOf("admin.rpc('create_customer_invoice'")
    const setLanguage = src.indexOf('await setOpeningDocumentLanguage(')
    expect(created).toBeGreaterThan(0)
    expect(setLanguage).toBeGreaterThan(created)
    expect(src).toContain('carriedOver: parsed.data.documentLanguage')
  })

  it('a rebuild carries the replaced draft\'s language, as it carries the collection flag', () => {
    const src = read('src/app/actions/invoicing/rebuild-invoice.ts')
    expect(src).toContain("select('id, status, hubspot_deal_id, is_collection, document_language')")
    expect(src).toContain('documentLanguage: documentLanguage(invoice.document_language)')
  })

  it('the migration only adds a column', () => {
    const sql = read('supabase/migrations/20260925000000_customer_invoice_document_language.sql')
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(statements).toMatch(/add column if not exists document_language text not null default 'en'/)
    expect(statements).toMatch(/check \(document_language in \('en', 'fr', 'es'\)\)/)
    expect(statements).not.toMatch(/\b(drop|create or replace|create policy|create trigger|alter function)\b/i)
    const down = read('supabase/migrations/rollback/20260925000000_customer_invoice_document_language.down.sql')
    expect(down).toContain('drop column if exists document_language')
  })
})
