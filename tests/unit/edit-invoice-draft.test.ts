import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * editInvoiceDraft replaces a draft's lines through
 * hub_replace_commercial_invoice_lines.
 *
 * That function takes the invoice row FOR UPDATE and re-checks draft before it
 * deletes and inserts, the same lock hub_issue_commercial_invoice takes, so an
 * edit racing an issue can never rewrite an issued invoice. The action keeps its
 * validation, its reconciliation and its edit log; it must no longer delete or
 * insert lines itself. The session, next/cache and the service-role client are
 * fakes that record every RPC call and every table write.
 */

type Write = { table: string; op: string; payload: unknown }

const db = vi.hoisted(() => ({
  capabilities: new Set<string>(['invoice.create', 'cost.view']),
  invoice: null as { id: string; status: string; tax_total: number; seller_entity_code: string; buyer_entity_code: string } | null,
  organisations: ['EB-SRO', 'EB-GROUP'] as string[],
  rpcResult: null as unknown,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  writes: [] as Write[],
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: '00000000-0000-4000-8000-000000000001', email: 'finance@example.com' },
    profile: { organisations: db.organisations },
    capabilities: db.capabilities,
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args })
      return { data: db.rpcError ? null : db.rpcResult, error: db.rpcError }
    },
    from(table: string) {
      const record = (op: string, payload?: unknown) => {
        db.writes.push({ table, op, payload })
        return builder
      }
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        insert: (p: unknown) => record('insert', p),
        update: (p: unknown) => record('update', p),
        delete: () => record('delete'),
        upsert: (p: unknown) => record('upsert', p),
        maybeSingle: async () => ({ data: table === 'commercial_invoices' ? db.invoice : null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve, reject),
      }
      return builder
    },
  }),
}))

import { editInvoiceDraft } from '@/app/actions/invoices/edit-invoice-draft'

const ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'
const BEFORE = [{ sku: 'EBH9NA', product_name: 'Echo Barrier H9', qty: 10, unit_value: 27.01, line_total: 270.1, hs_code: null, sort_order: 0 }]

const lines = [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', qty: 10, unit_value: 27.014, hs_code: ' 3926  90 ' },
  { sku: 'CCSNA', product_name: 'CS Enclosure Frame', qty: 3, unit_value: 107.67, hs_code: '' },
]

beforeEach(() => {
  db.organisations = ['EB-SRO', 'EB-GROUP']
  db.capabilities = new Set(['invoice.create', 'cost.view'])
  db.invoice = { id: ID, status: 'draft', tax_total: 0, seller_entity_code: 'EB-SRO', buyer_entity_code: 'EB-GROUP' }
  db.rpcResult = { ok: true, before: BEFORE }
  db.rpcError = null
  db.rpcCalls = []
  db.writes = []
})

describe('editing a commercial invoice draft', () => {
  it('answers not found for an invoice between organisations the caller does not hold', async () => {
    // Dean, 15 Sep 2026: the organisation is the outer scope of everything.
    // The same words as a missing invoice, so nothing leaks about its existence.
    db.organisations = ['EB-USA']
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res).toEqual({ ok: false, error: 'Invoice not found.' })
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('replaces the lines and totals in one call to the locking function', async () => {
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res).toEqual({ ok: true, subtotal: 593.11, total: 593.11 })
    expect(db.rpcCalls).toHaveLength(1)
    const [call] = db.rpcCalls
    expect(call.fn).toBe('hub_replace_commercial_invoice_lines')
    expect(call.args.p_invoice_id).toBe(ID)
    // Reconciled: unit value rounded first, line total exact, code normalised, blank to null.
    expect(call.args.p_lines).toEqual([
      { sku: 'EBH9NA', product_name: 'Echo Barrier H9', qty: 10, unit_value: 27.01, line_total: 270.1, hs_code: '3926 90', sort_order: 0 },
      { sku: 'CCSNA', product_name: 'CS Enclosure Frame', qty: 3, unit_value: 107.67, line_total: 323.01, hs_code: null, sort_order: 1 },
    ])
    expect(call.args.p_header).toEqual({ subtotal: 593.11, total: 593.11 })
  })

  it('never deletes, inserts or updates invoice lines or the header itself', async () => {
    await editInvoiceDraft({ invoice_id: ID, lines })
    expect(db.writes.filter((w) => w.table === 'commercial_invoice_lines')).toEqual([])
    expect(db.writes.filter((w) => w.table === 'commercial_invoices')).toEqual([])
  })

  it('logs the edit with the lines the function replaced as the before', async () => {
    await editInvoiceDraft({ invoice_id: ID, lines })
    const log = db.writes.filter((w) => w.table === 'commercial_invoice_edit_log')
    expect(log).toHaveLength(1)
    expect(log[0].op).toBe('insert')
    expect(log[0].payload).toMatchObject({
      invoice_id: ID,
      edited_by: '00000000-0000-4000-8000-000000000001',
      before: { lines: BEFORE },
      after: { subtotal: 593.11, total: 593.11 },
    })
  })

  it('refuses when the invoice stopped being a draft under the lock, and logs nothing', async () => {
    db.rpcResult = { ok: false, reason: 'not_draft', status: 'issued' }
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res).toEqual({
      ok: false,
      error: "Only a draft invoice can be edited (this one is 'issued'). Void it to re-issue.",
    })
    expect(db.writes).toEqual([])
  })

  it('refuses when the function call fails, and logs nothing', async () => {
    db.rpcError = { message: 'boom' }
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses an already-issued invoice before calling the function', async () => {
    db.invoice = { id: ID, status: 'issued', tax_total: 0, seller_entity_code: 'EB-SRO', buyer_entity_code: 'EB-GROUP' }
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res.ok).toBe(false)
    expect(db.rpcCalls).toEqual([])
  })

  it('refuses an invalid HS code before anything reaches the database', async () => {
    const res = await editInvoiceDraft({ invoice_id: ID, lines: [{ ...lines[0], hs_code: '12AB' }] })
    expect(res.ok).toBe(false)
    expect(db.rpcCalls).toEqual([])
    expect(db.writes).toEqual([])
  })

  it('needs invoice.create and cost.view', async () => {
    db.capabilities = new Set(['invoice.create'])
    const res = await editInvoiceDraft({ invoice_id: ID, lines })
    expect(res.ok).toBe(false)
    expect(db.rpcCalls).toEqual([])
  })
})
