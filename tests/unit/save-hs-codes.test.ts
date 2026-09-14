import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * saveHsCodes, the save round trip, against an in-memory product_hs_codes.
 *
 * The end-to-end spec used to save a format-valid fake code into the LIVE table
 * and then try to put the old one back. It no longer writes anything; the round
 * trip is proven here instead. The session, next/cache and the service-role
 * client are fakes: the admin client answers the SKU lookups from two small
 * lists and applies upserts and deletes to a Map, so what the action wrote can
 * be read straight back.
 */

type Leg = 'SRO_TO_GROUP' | 'GROUP_TO_USA' | 'GROUP_TO_CANADA'

const db = vi.hoisted(() => ({
  capabilities: new Set<string>(['invoice.create']),
  pricedSkus: [] as string[],
  activeCatalogSkus: [] as string[],
  /** `${sku}|${leg}` to hs_code */
  hsCodes: new Map<string, string>(),
  writes: [] as { op: 'upsert' | 'delete'; payload: unknown }[],
  failLookup: false,
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
      const eqs: [string, unknown][] = []
      let inLegs: string[] = []
      let op: 'select' | 'upsert' | 'delete' = 'select'
      let payload: unknown
      const run = () => {
        if (op === 'upsert') {
          db.writes.push({ op, payload })
          for (const row of payload as { sku: string; leg: string; hs_code: string }[]) db.hsCodes.set(`${row.sku}|${row.leg}`, row.hs_code)
          return { data: null, error: null }
        }
        if (op === 'delete') {
          const sku = eqs.find(([c]) => c === 'sku')?.[1] as string
          db.writes.push({ op, payload: { sku, legs: inLegs } })
          for (const leg of inLegs) db.hsCodes.delete(`${sku}|${leg}`)
          return { data: null, error: null }
        }
        if (db.failLookup) return { data: null, error: { message: 'boom' } }
        const sku = eqs.find(([c]) => c === 'sku')?.[1] as string
        const list = table === 'intercompany_prices' ? db.pricedSkus : table === 'po_product_catalog' ? db.activeCatalogSkus : []
        if (table === 'po_product_catalog' && !eqs.some(([c, v]) => c === 'active' && v === true)) {
          throw new Error('the catalogue lookup must be limited to active products')
        }
        return { data: list.includes(sku) ? [{ sku }] : [], error: null }
      }
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqs.push([col, val])
          return builder
        },
        in: (_col: string, vals: string[]) => {
          inLegs = vals
          return builder
        },
        limit: () => builder,
        upsert: (p: unknown) => {
          op = 'upsert'
          payload = p
          return builder
        },
        delete: () => {
          op = 'delete'
          return builder
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve().then(run).then(resolve, reject),
      }
      return builder
    },
  }),
}))

import { saveHsCodes } from '@/app/actions/invoices/save-hs-codes'

const code = (sku: string, leg: Leg) => db.hsCodes.get(`${sku}|${leg}`)

beforeEach(() => {
  db.capabilities = new Set(['invoice.create'])
  db.pricedSkus = ['EBH9NA']
  db.activeCatalogSkus = ['EBH9NA', 'EBVFKNA']
  db.hsCodes = new Map()
  db.writes = []
  db.failLookup = false
})

describe('saveHsCodes round trip', () => {
  it('saves a code, normalised, and it reads back', async () => {
    const res = await saveHsCodes({ sku: 'EBH9NA', codes: { SRO_TO_GROUP: '  3926   90 97 ' } })
    expect(res).toEqual({ ok: true, codes: { SRO_TO_GROUP: '3926 90 97' } })
    expect(code('EBH9NA', 'SRO_TO_GROUP')).toBe('3926 90 97')
  })

  it('touches only the legs it receives, leaving a code saved elsewhere alone', async () => {
    db.hsCodes.set('EBH9NA|GROUP_TO_USA', '3926.90.1000')
    db.hsCodes.set('EBH9NA|GROUP_TO_CANADA', '3926.90.9990')
    const res = await saveHsCodes({ sku: 'EBH9NA', codes: { SRO_TO_GROUP: '3926.90' } })
    expect(res.ok).toBe(true)
    expect(code('EBH9NA', 'SRO_TO_GROUP')).toBe('3926.90')
    expect(code('EBH9NA', 'GROUP_TO_USA')).toBe('3926.90.1000')
    expect(code('EBH9NA', 'GROUP_TO_CANADA')).toBe('3926.90.9990')
    expect(db.writes).toEqual([
      { op: 'upsert', payload: [expect.objectContaining({ sku: 'EBH9NA', leg: 'SRO_TO_GROUP', hs_code: '3926.90' })] },
    ])
  })

  it('deletes a leg received blank, and only that leg', async () => {
    db.hsCodes.set('EBH9NA|SRO_TO_GROUP', '3926.90')
    db.hsCodes.set('EBH9NA|GROUP_TO_USA', '3926.90.1000')
    const res = await saveHsCodes({ sku: 'EBH9NA', codes: { GROUP_TO_USA: '   ' } })
    expect(res).toEqual({ ok: true, codes: { GROUP_TO_USA: '' } })
    expect(code('EBH9NA', 'GROUP_TO_USA')).toBeUndefined()
    expect(code('EBH9NA', 'SRO_TO_GROUP')).toBe('3926.90')
    expect(db.writes).toEqual([{ op: 'delete', payload: { sku: 'EBH9NA', legs: ['GROUP_TO_USA'] } }])
  })

  it('accepts a product in the active catalogue that has no transfer price', async () => {
    const res = await saveHsCodes({ sku: 'EBVFKNA', codes: { GROUP_TO_USA: '7326.90' } })
    expect(res.ok).toBe(true)
    expect(code('EBVFKNA', 'GROUP_TO_USA')).toBe('7326.90')
  })

  it('refuses a SKU that is neither priced nor in the catalogue, and writes nothing', async () => {
    const res = await saveHsCodes({ sku: 'NOT-A-PRODUCT', codes: { SRO_TO_GROUP: '3926.90' } })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses when the product lookup fails, rather than treating it as unknown or known', async () => {
    db.failLookup = true
    const res = await saveHsCodes({ sku: 'EBH9NA', codes: { SRO_TO_GROUP: '3926.90' } })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('refuses a code in the wrong format, and writes nothing', async () => {
    for (const bad of ['12AB', '3926..90', '39269']) {
      const res = await saveHsCodes({ sku: 'EBH9NA', codes: { SRO_TO_GROUP: bad } })
      expect(res.ok, bad).toBe(false)
    }
    expect(db.writes).toEqual([])
  })

  it('refuses an empty codes object and an unknown leg', async () => {
    expect((await saveHsCodes({ sku: 'EBH9NA', codes: {} })).ok).toBe(false)
    expect((await saveHsCodes({ sku: 'EBH9NA', codes: { STAR: '3926.90' } as never })).ok).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('needs invoice.create', async () => {
    db.capabilities = new Set(['invoice.view'])
    const res = await saveHsCodes({ sku: 'EBH9NA', codes: { SRO_TO_GROUP: '3926.90' } })
    expect(res.ok).toBe(false)
    expect(db.writes).toEqual([])
  })
})
