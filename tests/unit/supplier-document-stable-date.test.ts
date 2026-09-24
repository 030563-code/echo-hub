import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SroPoBom } from '@/lib/erp-types'
import type { SpecDraft } from '@/lib/po-spec-draft'

/**
 * The same order prints the same date, whenever it is opened.
 *
 * The factory's first order read a different date every time it was downloaded, because the
 * documents printed the moment of download. The fix dated them by the send, but an order nobody
 * had sent yet still printed today, and the bill of materials tab printed today for everything.
 *
 * So this renders the real documents twice, with the clock nine days apart, and compares the date
 * each one printed. Only the database is faked. Every id, number and date below is invented.
 */

const drawn = vi.hoisted(() => [] as string[])
vi.mock('jspdf', async (original) =>
  (await import('./pdf-text')).recordingJsPdf(await original<typeof import('jspdf')>(), drawn))

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({ purchase_orders: [] as Row[], po_manufacturing: [] as Row[] }))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: 'purchase_orders' | 'po_manufacturing') => {
      const filters: [string, unknown][] = []
      const api = {
        select: () => api,
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return api
        },
        maybeSingle: async () => ({
          data: db[table].find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
          error: null,
        }),
      }
      return api
    },
  }),
}))

const BOM: SroPoBom = {
  id: 'test-group-order',
  po_number: 'TEST-GRP-1',
  master_ref: null,
  from_entity: 'EB-GROUP',
  to_entity: 'EB-SRO',
  approved_at: null,
  created_at: '2026-03-02T10:00:00Z',
  lines: [
    {
      sku: 'TEST-SKU',
      product_name: 'Test barrier',
      quantity: 70,
      model_code: 'H9',
      has_bom: true,
      components: [],
      bamida_man_eur: 10,
      bamida_print_eur: 2,
      components_eur_unit: 0,
      bamida_total_line: 0,
      sro_total_line: 0,
    },
  ],
  bamida_total: 0,
  sro_total: 0,
}

const DRAFT: SpecDraft = {
  destination: null,
  products: [
    {
      model: 'H9', name: 'Test barrier', quantity: 70, packSize: 70, pallets: 1,
      materials: [], specRows: [], bullets: [], sourceDocument: null,
    },
  ],
  packing: { pallets: 1, palletCovers: 1, metalFrames: 1 },
}

vi.mock('@/lib/bom', () => ({ loadSroPoBom: async () => BOM }))
vi.mock('@/lib/suppliers', () => ({ getSupplierByCode: async () => null }))
vi.mock('@/lib/po-spec-store', () => ({
  loadSpecDocument: async () => ({
    draft: DRAFT, generated: null, saved: true,
    updatedAt: null, updatedByUid: null, confirmedAt: null, confirmedByUid: null,
  }),
  specSavedPacking: async () => null,
}))
vi.mock('@/lib/po-priced-store', () => ({ readPricedDocument: async () => null }))
vi.mock('@/lib/cargo-request-store', () => ({ loadCargoRequest: async () => null }))

const { renderSupplierDocument } = await import('@/lib/bamida-po-document')

const ORDER = 'test-manufacturing-order'
const RAISED = '2026-03-09T16:40:00Z'
const SENT = '2026-03-10T09:15:00Z'

/** The date the document printed, rendered with the clock at `clock`. */
async function dateOn(kind: 'specification' | 'priced', clock: string): Promise<string | undefined> {
  vi.setSystemTime(new Date(clock))
  drawn.length = 0
  const res = await renderSupplierDocument(ORDER, kind)
  expect(res.ok, `${kind} rendered`).toBe(true)
  // The -1 is Slovak and the -3 is not, so each labels its date its own way.
  return drawn.find((s) => /^(Dátum|Date): /.test(s))
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  db.purchase_orders = [
    { id: ORDER, po_number: 'TEST-MFG-1', parent_po_id: BOM.id, from_entity: 'EB-SRO', delivery_address: null, created_at: RAISED },
    { id: BOM.id, po_number: BOM.po_number, parent_po_id: null, from_entity: 'EB-GROUP', delivery_address: null, created_at: BOM.created_at },
  ]
  db.po_manufacturing = []
})

describe('two renders at different clock times print the same date', () => {
  for (const [kind, label] of [['specification', 'Dátum'], ['priced', 'Date']] as const) {
    it(`the ${kind} document of a sent order prints the day it was sent`, async () => {
      db.po_manufacturing = [{ po_id: ORDER, sent_at: SENT }]
      const first = await dateOn(kind, '2026-03-11T08:00:00Z')
      const later = await dateOn(kind, '2026-03-20T21:30:00Z')
      expect(first).toBe(`${label}: 2026-03-10`)
      expect(later).toBe(first)
    })

    it(`the ${kind} document of an order nobody has sent yet prints the day it was raised`, async () => {
      const first = await dateOn(kind, '2026-03-11T08:00:00Z')
      const later = await dateOn(kind, '2026-03-20T21:30:00Z')
      expect(first).toBe(`${label}: 2026-03-09`)
      expect(later).toBe(first)
    })
  }
})

describe('the bill of materials tab dates the priced order the same way', () => {
  // A server page, so this pins the wiring; the rule itself is supplierDocumentDate, tested above.
  const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/bom/page.tsx'), 'utf8')

  it('reads the date from the order, not from the clock', () => {
    expect(page).toContain('loadManufacturingDocumentDates(ids)')
    expect(page).toContain('datesBySro[po.id] ?? supplierDocumentDate(null, po.created_at)')
    expect(page).not.toMatch(/new Date\(\)/)
  })
})
