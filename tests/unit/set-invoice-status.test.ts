import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * setInvoiceStatus issues through hub_issue_commercial_invoice and voids with a
 * guarded update.
 *
 * Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro to
 * group and group to depots". The HS code check and the status flip now happen
 * together in the database function, under a row lock that the draft editor's
 * line replacement also takes, so an edit racing an issue can never rewrite an
 * issued invoice. This action's job is to call that function after its own
 * checks and to turn a refusal into words. The session, the service-role client
 * and next/cache are fakes that record every write and every RPC call.
 */

type Write = { table: string; payload: unknown; filters: [string, unknown][] }
type RpcCall = { fn: string; args: unknown }

const db = vi.hoisted(() => ({
  capabilities: new Set<string>(['invoice.create']),
  invoice: null as { id: string; status: string; seller_entity_code: string; buyer_entity_code: string } | null,
  organisations: ['EB-SRO', 'EB-GROUP'] as string[],
  rpcResult: null as unknown,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as RpcCall[],
  writes: [] as Write[],
  linesRead: 0,
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: '00000000-0000-4000-8000-000000000001' },
    profile: { organisations: db.organisations },
    capabilities: db.capabilities,
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      db.rpcCalls.push({ fn, args })
      return { data: db.rpcError ? null : db.rpcResult, error: db.rpcError }
    },
    from(table: string) {
      let op: 'select' | 'update' = 'select'
      let payload: unknown
      const filters: [string, unknown][] = []
      const result = () => {
        if (op === 'update') {
          db.writes.push({ table, payload, filters })
          return { data: null, error: null }
        }
        if (table === 'commercial_invoice_lines') db.linesRead++
        return { data: null, error: null }
      }
      const builder = {
        select: () => builder,
        order: () => builder,
        update: (p: unknown) => {
          op = 'update'
          payload = p
          return builder
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val])
          return builder
        },
        maybeSingle: async () => ({ data: table === 'commercial_invoices' ? db.invoice : null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

import { setInvoiceStatus } from '@/app/actions/invoices/set-invoice-status'

const ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'

beforeEach(() => {
  db.organisations = ['EB-SRO', 'EB-GROUP']
  db.capabilities = new Set(['invoice.create'])
  db.invoice = { id: ID, status: 'draft', seller_entity_code: 'EB-SRO', buyer_entity_code: 'EB-GROUP' }
  db.rpcResult = { ok: true, status: 'issued' }
  db.rpcError = null
  db.rpcCalls = []
  db.writes = []
  db.linesRead = 0
})

describe('issuing a commercial invoice', () => {
  it('answers not found for an invoice between organisations the caller does not hold', async () => {
    // Dean, 15 Sep 2026: the organisation is the outer scope of everything.
    // The same words as a missing invoice, so nothing leaks about its existence.
    db.organisations = ['EB-USA']
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res).toEqual({ ok: false, error: 'Invoice not found.' })
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('issues through hub_issue_commercial_invoice and writes nothing itself', async () => {
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res).toEqual({ ok: true, status: 'issued' })
    expect(db.rpcCalls).toEqual([{ fn: 'hub_issue_commercial_invoice', args: { p_invoice_id: ID } }])
    expect(db.writes).toEqual([])
    // The HS code check lives in the function, under the lock, not in a read here.
    expect(db.linesRead).toBe(0)
  })

  it('names the products when the function refuses for missing HS codes', async () => {
    db.rpcResult = {
      ok: false,
      reason: 'missing_hs_codes',
      missing_skus: ['CCSNA'],
      lines: [
        { sku: 'EBH9NA', product_name: 'Echo Barrier H9', hs_code: '3926.90' },
        { sku: 'CCSNA', product_name: 'Compact Cutting Station', hs_code: null },
      ],
    }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('cannot be issued')
    expect(res.error).toContain('Compact Cutting Station (CCSNA)')
    expect(res.error).toContain('HS codes tab')
    expect(res.error).not.toContain('EBH9NA')
    expect(res.error).not.toContain('\u2014')
    expect(db.writes).toEqual([])
  })

  it('tells split parts to be typed on the draft, not set on the HS codes tab', async () => {
    db.rpcResult = {
      ok: false,
      reason: 'missing_hs_codes',
      missing_skus: ['CCSNA', 'CCSNA'],
      lines: [
        { sku: 'CCSNA', product_name: 'CS Enclosure Frame', hs_code: null },
        { sku: 'CCSNA', product_name: 'CS Enclosure Body', hs_code: null },
      ],
    }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('2 lines have no HS code')
    expect(res.error).toContain('type each code on the draft with Edit')
    expect(res.error).not.toContain('set the code on the HS codes tab')
  })

  it('reports a draft that stopped being a draft under the lock', async () => {
    db.rpcResult = { ok: false, reason: 'not_draft', status: 'void' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res).toEqual({ ok: false, error: "Cannot issue an invoice that is 'void'." })
  })

  it('refuses an invoice with no lines at all', async () => {
    db.rpcResult = { ok: false, reason: 'no_lines' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses when the function call fails, rather than reporting success', async () => {
    db.rpcError = { message: 'boom' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res).toEqual({ ok: false, error: 'Could not issue the invoice.' })
    expect(db.writes).toEqual([])
  })

  it('still refuses an illegal jump before calling the function', async () => {
    db.invoice = { id: ID, status: 'issued', seller_entity_code: 'EB-SRO', buyer_entity_code: 'EB-GROUP' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('still needs invoice.create', async () => {
    db.capabilities = new Set(['invoice.view'])
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })
})

describe('voiding a commercial invoice', () => {
  it('voids a draft with the optimistic status guard, without the issue function', async () => {
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'void' })
    expect(res).toEqual({ ok: true, status: 'void' })
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([
      { table: 'commercial_invoices', payload: { status: 'void' }, filters: [['id', ID], ['status', 'draft']] },
    ])
  })
})
