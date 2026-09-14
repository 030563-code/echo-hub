import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * setInvoiceStatus refuses to issue an invoice while any line has no HS code.
 *
 * Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro to
 * group and group to depots". The list and the draft editor show the same rule,
 * but this action is the public endpoint, so this is where it has to hold. The
 * session, the service-role client and next/cache are replaced with fakes that
 * record every write, and the action itself runs unchanged.
 */

type Line = { sku: string; product_name: string | null; hs_code: string | null; sort_order: number }
type Write = { table: string; payload: unknown; filters: [string, unknown][] }

const db = vi.hoisted(() => ({
  capabilities: new Set<string>(['invoice.create']),
  invoice: null as { id: string; status: string } | null,
  lines: [] as Line[] | null,
  linesError: null as { message: string } | null,
  linesRead: 0,
  writes: [] as Write[],
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: '00000000-0000-4000-8000-000000000001' },
    profile: {},
    capabilities: db.capabilities,
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      let op: 'select' | 'update' = 'select'
      let payload: unknown
      const filters: [string, unknown][] = []
      const result = () => {
        if (op === 'update') {
          db.writes.push({ table, payload, filters })
          return { data: null, error: null }
        }
        if (table === 'commercial_invoice_lines') {
          db.linesRead++
          return { data: db.linesError ? null : db.lines, error: db.linesError }
        }
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
  db.capabilities = new Set(['invoice.create'])
  db.invoice = { id: ID, status: 'draft' }
  db.lines = [
    { sku: 'EBH9NA', product_name: 'Echo Barrier H9', hs_code: '3926.90', sort_order: 0 },
    { sku: 'CCSNA', product_name: 'Compact Cutting Station', hs_code: '3926 90 97', sort_order: 1 },
  ]
  db.linesError = null
  db.linesRead = 0
  db.writes = []
})

describe('issuing a commercial invoice', () => {
  it('issues a draft whose every line has an HS code, keeping the optimistic status guard', async () => {
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res).toEqual({ ok: true, status: 'issued' })
    expect(db.writes).toEqual([
      { table: 'commercial_invoices', payload: { status: 'issued' }, filters: [['id', ID], ['status', 'draft']] },
    ])
  })

  it('refuses when a line has a null HS code, names the product, and writes nothing', async () => {
    db.lines![1].hs_code = null
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('cannot be issued')
    expect(res.error).toContain('Compact Cutting Station (CCSNA)')
    expect(res.error).not.toContain('EBH9NA')
    expect(db.writes).toEqual([])
  })

  it('refuses when a line has a blank HS code', async () => {
    db.lines![0].hs_code = '   '
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses when the lines cannot be read, rather than treating that as nothing missing', async () => {
    db.linesError = { message: 'boom' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses an invoice with no lines at all', async () => {
    db.lines = []
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('still refuses an illegal jump before looking at the lines', async () => {
    db.invoice = { id: ID, status: 'issued' }
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.linesRead).toBe(0)
    expect(db.writes).toEqual([])
  })

  it('still needs invoice.create', async () => {
    db.capabilities = new Set(['invoice.view'])
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'issue' })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })
})

describe('voiding a commercial invoice', () => {
  it('voids a draft even when lines have no HS code', async () => {
    db.lines = [{ sku: 'EBH9NA', product_name: 'Echo Barrier H9', hs_code: null, sort_order: 0 }]
    const res = await setInvoiceStatus({ invoice_id: ID, action: 'void' })
    expect(res).toEqual({ ok: true, status: 'void' })
    expect(db.writes).toEqual([
      { table: 'commercial_invoices', payload: { status: 'void' }, filters: [['id', ID], ['status', 'draft']] },
    ])
  })
})
