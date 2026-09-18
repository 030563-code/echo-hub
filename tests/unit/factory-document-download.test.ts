import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { strings } from '@/lib/factory/strings'

/**
 * The download endpoint itself, called for real.
 *
 * Every export of a 'use server' file is a public endpoint: anyone with a
 * session can POST to it with any ids they like. The source-level guards in
 * factory-shared-files.test.ts prove the gate is written; this proves it is
 * obeyed. Without it, "call gate() and ignore the answer" passes CI and hands
 * any signed-in account a signed URL into a private bucket.
 */

type Row = Record<string, unknown>

const db: {
  capabilities: Set<string>
  manufacturing: Row[]
  attachments: Row[]
  signed: string[]
} = { capabilities: new Set(), manufacturing: [], attachments: [], signed: [] }

function builder(rows: Row[]) {
  const filters: [string, unknown][] = []
  const notNull: string[] = []
  const key = (c: string) => c.split('.').pop() as string
  const matched = () =>
    rows.filter(
      (r) =>
        filters.every(([c, v]) => r[key(c)] === v) &&
        notNull.every((c) => r[key(c)] !== null && r[key(c)] !== undefined),
    )
  const api = {
    select: () => api,
    order: () => ({ data: matched(), error: null }),
    not: (column: string, operator: string, value: unknown) => {
      if (operator === 'is' && value === null) notNull.push(column)
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return api
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
  }
  return api
}

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
    from: (table: string) => builder(table === 'po_manufacturing' ? db.manufacturing : db.attachments),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, seconds: number) => {
          db.signed.push(`${path}|${seconds}`)
          return { data: { signedUrl: `https://storage.example/${path}?token=x` }, error: null }
        },
      }),
    },
  }),
}))

vi.mock('@/lib/factory/locale.server', () => ({
  factoryStrings: async () => ({ t: strings('en'), locale: 'en' as const }),
}))

// Kept out of the import graph: this test is about one endpoint, not the PDF
// renderer, the mailer or the guide.
vi.mock('@/lib/factory/updates', () => ({
  DateInput: z.string().nullable(),
  applyManufacturingDates: async () => ({ ok: true }),
  confirmManufacturingOrder: async () => ({ ok: true }),
  finishManufacturingOrder: async () => ({ ok: true }),
}))
vi.mock('@/app/actions/factory/notify-po-confirmed', () => ({ notifyPoConfirmed: async () => undefined }))
vi.mock('@/lib/bamida-po-document', () => ({ renderSupplierDocument: async () => ({ ok: false }) }))
vi.mock('@/lib/send-contacts', () => ({ factoryLogin: async () => null, loadSendContacts: async () => [] }))
vi.mock('@/lib/factory-guide', () => ({ factoryGuideAttachment: async () => null }))

const { getFactoryDocumentUrl } = await import('@/app/actions/factory/orders')

const PO = '11111111-1111-4111-8111-111111111111'
const SHARED = '22222222-2222-4222-8222-222222222222'
const INTERNAL = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  db.capabilities = new Set(['factory.view', 'factory.update'])
  db.manufacturing = [
    { po_id: PO, sent_at: '2026-09-17T09:00:00Z', leg: 'SRO_TO_SUPPLIER', to_entity: 'SUPPLIER' },
  ]
  db.attachments = [
    { id: SHARED, po_id: PO, filename: 'logo.png', storage_path: `${PO}/logo.png`, share_with_manufacturer: true },
    { id: INTERNAL, po_id: PO, filename: 'invoice.pdf', storage_path: `${PO}/invoice.pdf`, share_with_manufacturer: false },
  ]
  db.signed = []
})

describe('getFactoryDocumentUrl', () => {
  it('signs a ticked file for five minutes', async () => {
    const res = await getFactoryDocumentUrl({ poId: PO, attachmentId: SHARED })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.filename).toBe('logo.png')
    expect(db.signed).toEqual([`${PO}/logo.png|300`])
  })

  it('refuses an account without factory.view, and signs nothing', async () => {
    db.capabilities = new Set(['po.view', 'cost.view', 'quotes.create'])
    const res = await getFactoryDocumentUrl({ poId: PO, attachmentId: SHARED })
    expect(res.ok).toBe(false)
    expect(db.signed).toEqual([])
  })

  it('refuses a file nobody ticked', async () => {
    const res = await getFactoryDocumentUrl({ poId: PO, attachmentId: INTERNAL })
    expect(res.ok).toBe(false)
    expect(db.signed).toEqual([])
  })

  it('refuses an order that was never sent', async () => {
    db.manufacturing = [{ po_id: PO, sent_at: null, leg: 'SRO_TO_SUPPLIER', to_entity: 'SUPPLIER' }]
    const res = await getFactoryDocumentUrl({ poId: PO, attachmentId: SHARED })
    expect(res.ok).toBe(false)
    expect(db.signed).toEqual([])
  })

  it('refuses a leg that does not end at the manufacturer', async () => {
    db.manufacturing = [
      { po_id: PO, sent_at: '2026-09-17T09:00:00Z', leg: 'EB_GROUP_TO_SRO', to_entity: 'SRO' },
    ]
    const res = await getFactoryDocumentUrl({ poId: PO, attachmentId: SHARED })
    expect(res.ok).toBe(false)
    expect(db.signed).toEqual([])
  })

  it('refuses ids that are not ids, before touching the database', async () => {
    const res = await getFactoryDocumentUrl({ poId: 'not-a-uuid', attachmentId: SHARED })
    expect(res.ok).toBe(false)
    expect(db.signed).toEqual([])
  })
})
