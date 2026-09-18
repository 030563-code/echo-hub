import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Files the factory may download, and the two gates that decide it.
 *
 * Jozef Šidík, 18 Sep 2026: the order document carries no previews when the
 * order includes a logo. Dean, the same day: "Juraj and Martin must be able to
 * attach documents/images... let it show on the factory page only". So a file
 * reaches Bamida when, and only when, somebody here ticked it AND it hangs off
 * an order the factory can already see. Everything else in that bucket is a
 * vendor invoice or a costed sheet.
 *
 * The fake client below applies the filters for real rather than recording that
 * they were called, so a dropped `.eq` fails the test with the wrong row rather
 * than passing with the right call.
 */

type Row = Record<string, unknown>

const db: { manufacturing: Row[]; attachments: Row[] } = { manufacturing: [], attachments: [] }

function builder(rows: Row[]) {
  const filters: [string, unknown][] = []
  const notNull: string[] = []
  const api = {
    select: () => api,
    order: () => resolve(),
    // .not('sent_at', 'is', null) is half the visibility gate, so the fake has
    // to honour it or dropping it from the source would keep the suite green.
    not: (column: string, operator: string, value: unknown) => {
      if (operator === 'is' && value === null) notNull.push(column)
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return api
    },
    maybeSingle: async () => {
      const data = matched()
      return { data: data[0] ?? null, error: null }
    },
    then: (onOk: (r: { data: Row[]; error: null }) => unknown) => onOk(resolve()),
  }
  // A join filter such as 'purchase_orders.leg' reads the flattened field.
  const key = (c: string) => c.split('.').pop() as string
  const matched = () =>
    rows.filter(
      (r) =>
        filters.every(([c, v]) => r[key(c)] === v) &&
        notNull.every((c) => r[key(c)] !== null && r[key(c)] !== undefined),
    )
  const resolve = () => ({ data: matched(), error: null as null })
  return api
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => builder(table === 'po_manufacturing' ? db.manufacturing : db.attachments),
  }),
}))

const { loadFactoryDocuments, factorySharedFile } = await import('@/lib/factory/orders')

const SENT = { po_id: 'po-1', sent_at: '2026-09-17T09:00:00Z', leg: 'SRO_TO_SUPPLIER', to_entity: 'SUPPLIER' }
const shared = {
  id: 'att-1',
  po_id: 'po-1',
  filename: 'logo-artwork.png',
  content_type: 'image/png',
  size_bytes: 2048,
  created_at: '2026-09-18T10:00:00Z',
  storage_path: 'po-1/att-1-logo-artwork.png',
  share_with_manufacturer: true,
}
const internal = { ...shared, id: 'att-2', filename: 'supplier-invoice.pdf', share_with_manufacturer: false }
const otherOrder = { ...shared, id: 'att-3', po_id: 'po-2', filename: 'other-order.png' }

beforeEach(() => {
  db.manufacturing = [SENT]
  db.attachments = [shared, internal, otherOrder]
})

describe('loadFactoryDocuments', () => {
  it('returns only the files ticked for the manufacturer', async () => {
    const docs = await loadFactoryDocuments('po-1')
    expect(docs.map((d) => d.filename)).toEqual(['logo-artwork.png'])
  })

  it('never returns a file from another order', async () => {
    db.attachments = [otherOrder]
    expect(await loadFactoryDocuments('po-1')).toEqual([])
  })

  it('returns nothing at all for an order the factory cannot see', async () => {
    // Not sent, or not the manufacturing leg: the same predicate as the list.
    db.manufacturing = []
    expect(await loadFactoryDocuments('po-1')).toEqual([])
    db.manufacturing = [{ ...SENT, leg: 'EB_GROUP_TO_SRO' }]
    expect(await loadFactoryDocuments('po-1')).toEqual([])
  })

  it('returns nothing for a manufacturing order that was raised but never sent', () => {
    // Nobody has told them it exists, so it is not theirs to read yet. The
    // visibility gate is sent_at as much as it is the leg.
    db.manufacturing = [{ ...SENT, sent_at: null }]
    return expect(loadFactoryDocuments('po-1')).resolves.toEqual([])
  })
})

describe('factorySharedFile', () => {
  it('gives up the storage path of a ticked file on their own order', async () => {
    expect(await factorySharedFile('po-1', 'att-1')).toMatchObject({ filename: 'logo-artwork.png' })
  })

  it('refuses an unticked file, even by its right id on the right order', async () => {
    expect(await factorySharedFile('po-1', 'att-2')).toBeNull()
  })

  it('refuses a ticked file that belongs to a different order', async () => {
    expect(await factorySharedFile('po-1', 'att-3')).toBeNull()
  })

  it('refuses everything on an order the factory cannot see', async () => {
    db.manufacturing = []
    expect(await factorySharedFile('po-1', 'att-1')).toBeNull()
  })

  it('refuses a ticked file on an order that was never sent', async () => {
    db.manufacturing = [{ ...SENT, sent_at: null }]
    expect(await factorySharedFile('po-1', 'att-1')).toBeNull()
  })
})

describe('the internal side of the tick', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  /**
   * One function's body, and nothing after it. Slicing to the end of the file
   * meant deletePoAttachment's own poChainHeldBy call satisfied an assertion
   * about setPoAttachmentShared, so removing the check from the one under test
   * would have kept the suite green.
   */
  const body = (source: string, name: string) => {
    const from = source.indexOf(`export async function ${name}`)
    expect(from, `${name} not found`).toBeGreaterThan(-1)
    const rest = source.slice(from + 1)
    const next = rest.indexOf('\nexport ')
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('loads the flag everywhere the tick is drawn', () => {
    // The board drawer and the single order page each run their own query. The
    // board's forgot the column, so its checkbox rendered unticked whatever the
    // database said, and clicking it to revoke sent share=true.
    for (const file of ['src/lib/po-detail.ts', 'src/app/(dashboard)/purchase-orders/page.tsx']) {
      const source = read(file)
      const select = source.slice(source.indexOf('po_attachments'))
      expect(select.slice(0, 400), `${file} does not load share_with_manufacturer`).toContain(
        'share_with_manufacturer',
      )
    }
  })

  it('is off by default, in the column itself', () => {
    const migration = read('supabase/migrations/20260918110000_po_attachment_share_with_manufacturer.sql')
    expect(migration).toContain('boolean not null default false')
    expect(migration).toContain('an existing attachment came out shared')
  })

  it('needs the same capability as attaching, and the order must be theirs', () => {
    const actions = read('src/app/actions/purchase-orders/attachments.ts')
    expect(actions).toContain('export async function setPoAttachmentShared')
    const fn = body(actions, 'setPoAttachmentShared')
    // Sharing needs the capability that opening the file needs, or a warehouse
    // account could publish a costed invoice it is refused when it clicks it.
    expect(fn).toContain('shared && !auth.capabilities.has("cost.view")')
    expect(fn).toContain('MANAGE_CAPS.some((c) => auth.capabilities.has(c))')
    expect(fn).toContain('poChainHeldBy')
    // A file can only be shared on the leg that has a manufacturer at the end.
    expect(fn).toContain("po?.leg !== \"SRO_TO_SUPPLIER\"")
  })

  it('opens the download with the factory gate, not the internal cost gate', () => {
    const actions = read('src/app/actions/factory/orders.ts')
    const fn = body(actions, 'getFactoryDocumentUrl')
    expect(fn).toContain("gate(parsed.data.poId, 'factory.view', t)")
    expect(fn).toContain('factorySharedFile(parsed.data.poId, parsed.data.attachmentId)')
    // Five minutes, and signed only after both gates have passed.
    expect(fn).toContain('createSignedUrl(file.storage_path, 300)')
    expect(fn.indexOf('factorySharedFile')).toBeLessThan(fn.indexOf('createSignedUrl'))
  })
})
