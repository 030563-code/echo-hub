import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Approving a purchase order leg, and sending it to Xero again, against a fake database.
 *
 * 24 Sep 2026. Two gaps closed together:
 *   - a line with no unit price went to Xero at 0 with nobody told, so the approval now shows
 *     those lines and needs them confirmed, and the server checks the confirmation;
 *   - a failed hand-off to n8n raised a toast and nothing else, and could never be sent again,
 *     so every outcome is now recorded on the leg and "Send to Xero again" re-posts the
 *     approval's own payload without approving again.
 *
 * The session client, the service-role client, fetch and the clock are all fakes. The fake
 * database evaluates the filters it is given, so the retry's claim is a real compare-and-set
 * here, not a recorded call. Every value is invented.
 */

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  capabilities: new Set<string>(['po.approve']),
  userId: '00000000-0000-4000-8000-00000000a001',
  /** Runs after an update, to play a second actor (n8n's write-back) at the worst moment. */
  afterUpdate: null as null | ((table: string, payload: Row) => void),
  /** Every update and upsert, in order, so a test can prove nothing was written at all. */
  writes: [] as { table: string; op: string }[],
}))

// ---------------------------------------------------------------------------
// A small in-memory PostgREST: the filters these actions use, evaluated for real
// ---------------------------------------------------------------------------

function splitTopLevel(expr: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  if (current) parts.push(current)
  return parts
}

function compare(a: unknown, b: string): number {
  const x = Date.parse(String(a))
  const y = Date.parse(b)
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
  return String(a).localeCompare(b)
}

function orFilter(expr: string): Filter {
  const conditions = splitTopLevel(expr).map((part): Filter => {
    const m = /^(\w+)\.(is|lt|eq|in)\.(.*)$/.exec(part)
    if (!m) throw new Error(`fake or() cannot read ${part}`)
    const [, col, op, value] = m
    if (op === 'is') return (r) => value === 'null' && r[col] == null
    if (op === 'lt') return (r) => r[col] != null && compare(r[col], value) < 0
    if (op === 'eq') return (r) => String(r[col] ?? '') === value
    const list = value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''))
    return (r) => list.includes(String(r[col]))
  })
  return (row) => conditions.some((c) => c(row))
}

const SEND_DEFAULTS: Row = {
  attempts: 0,
  last_attempt_at: null,
  last_attempt_by_uid: null,
  last_outcome: null,
  last_error: null,
  claimed_at: null,
  sandbox_at: null,
}

function query(table: string) {
  const filters: Filter[] = []
  let op: 'select' | 'update' | 'upsert' = 'select'
  let payload: Row = {}
  let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  let returning = false
  const rows = () => (db.tables[table] ??= [])

  const run = () => {
    const matched = rows().filter((r) => filters.every((f) => f(r)))
    if (op === 'select') return { data: matched.map((r) => structuredClone(r)), error: null }
    db.writes.push({ table, op })
    if (op === 'update') {
      for (const r of matched) Object.assign(r, payload)
      if (matched.length) db.afterUpdate?.(table, payload)
      return { data: returning ? matched.map((r) => structuredClone(r)) : null, error: null }
    }
    const key = upsertOptions.onConflict ?? 'id'
    const existing = rows().find((r) => r[key] === payload[key])
    if (existing) {
      if (!upsertOptions.ignoreDuplicates) Object.assign(existing, payload)
    } else {
      rows().push({ ...(table === 'po_xero_sends' ? SEND_DEFAULTS : {}), ...payload })
    }
    return { data: null, error: null }
  }

  const builder = {
    select: () => {
      if (op !== 'select') returning = true
      return builder
    },
    eq: (col: string, value: unknown) => {
      filters.push((r) => r[col] === value)
      return builder
    },
    is: (col: string, value: null) => {
      filters.push((r) => (r[col] ?? null) === value)
      return builder
    },
    in: (col: string, values: unknown[]) => {
      filters.push((r) => values.includes(r[col]))
      return builder
    },
    not: (col: string, operator: string, value: unknown) => {
      if (operator !== 'is' || value !== null) throw new Error('fake not() only knows is null')
      filters.push((r) => r[col] != null)
      return builder
    },
    or: (expr: string) => {
      filters.push(orFilter(expr))
      return builder
    },
    order: () => builder,
    update: (p: Row) => {
      op = 'update'
      payload = p
      return builder
    },
    upsert: (p: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      op = 'upsert'
      payload = p
      upsertOptions = options ?? {}
      return builder
    },
    maybeSingle: async () => {
      const res = run()
      return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: null }
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  }
  return builder
}

function client() {
  return {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args })
      // The approval RPC, as far as these actions can see it: the leg is approved by the label
      // and uid it was given.
      const po = (db.tables.purchase_orders ?? []).find((r) => r.id === args.p_po_id)
      if (!po || po.status !== 'requested') return { data: { ok: false, reason: 'not_approvable' }, error: null }
      Object.assign(po, {
        status: 'approved',
        approved_by: args.p_label,
        approved_by_uid: args.p_uid,
        approved_at: new Date().toISOString(),
      })
      return {
        data: { ok: true, awaiting_fulfilment: po.leg === 'EB_GROUP_TO_SRO', child_po_number: null },
        error: null,
      }
    },
  }
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  getAuthorizedUser: async () => ({
    ok: true,
    user: { id: db.userId, email: 'approver@example.test' },
    profile: { organisations: ['EB-USA', 'EB-GROUP'] },
    capabilities: db.capabilities,
  }),
}))

vi.mock('@/lib/supabase/server', () => ({ createServerClient: async () => client() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }))
vi.mock('@/lib/po-organisations', () => ({ poChainHeldBy: async () => true }))
vi.mock('@/lib/bom', () => ({ snapshotSroPoCost: vi.fn(async () => undefined) }))
vi.mock('@/lib/xero/attach-po-pdf', () => ({
  renderApprovalAttachment: vi.fn(async () => ({ filename: 'EBTST9001.pdf', content_base64: 'VEVTVA==' })),
}))
vi.mock('@/app/actions/purchase-orders/notify-sro', () => ({
  notifySroPoReady: vi.fn(async () => ({ sent: true, recipients: {} })),
}))

import { decidePurchaseOrder } from '@/app/actions/purchase-orders/decide-po'
import { sendToXeroAgain } from '@/app/actions/purchase-orders/send-to-xero-again'
import { XERO_SEND_TIMEOUT_MS } from '@/app/actions/purchase-orders/xero-handoff'
import { STAGING_SKIP_NOTE } from '@/lib/env'
import { loadXeroSendFailures } from '@/lib/po-xero-send.server'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Invented fixtures
// ---------------------------------------------------------------------------

const APPROVER = '00000000-0000-4000-8000-00000000a001'
const SOMEONE_ELSE = '00000000-0000-4000-8000-00000000b002'
const PO_ID = '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a'
const LINE_PANEL = '0b0b0b0b-2222-4222-8222-0b0b0b0b0b0b'
const LINE_CLIP = '0c0c0c0c-3333-4333-8333-0c0c0c0c0c0c'
const HOOK_URL = 'https://n8n.example.test/webhook/test-approval'
const HOOK_SECRET = 'test-secret-not-real'
const START = Date.parse('2026-03-02T14:00:00.000Z')
const MIN = 60_000

function seedLeg(over: Row = {}, lines?: Row[]) {
  db.tables.purchase_orders = [
    {
      id: PO_ID,
      po_number: 'EBTST9001',
      master_ref: 'MR-EBTST9001',
      parent_po_id: null,
      reference_po_number: null,
      leg: 'DEPOT_TO_EB_GROUP',
      status: 'requested',
      source: 'hub',
      from_entity: 'US-BAL',
      to_entity: 'EB-GROUP',
      delivery_address: '1 Test Street, Testville',
      notes: null,
      approved_at: null,
      approved_by: null,
      approved_by_uid: null,
      xero_po_id: null,
      lines: lines ?? [
        { id: LINE_PANEL, po_id: PO_ID, sku: 'TSTPANEL', product_name: 'Test panel', quantity: 4, hs_code: '0000.00', unit_price: null },
        { id: LINE_CLIP, po_id: PO_ID, sku: 'TSTCLIP', product_name: 'Test clip', quantity: 10, hs_code: null, unit_price: 3.5 },
      ],
      ...over,
    },
  ]
}

/** An approved Depot leg whose first send failed a minute after approval. */
function seedFailedSend(over: Row = {}) {
  seedLeg({
    status: 'approved',
    approved_at: new Date(START).toISOString(),
    approved_by: 'Test Approver',
    approved_by_uid: APPROVER,
  })
  db.tables.po_xero_sends = [
    {
      ...SEND_DEFAULTS,
      po_id: PO_ID,
      attempts: 1,
      last_attempt_at: new Date(START + 1 * MIN).toISOString(),
      last_attempt_by_uid: APPROVER,
      last_outcome: 'failed',
      last_error: 'The n8n workflow stopped with an error (HTTP 500). Its execution log in n8n says which step.',
      ...over,
    },
  ]
}

const sends = () => db.tables.po_xero_sends ?? []
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))

let fetchStatus = 200
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: fetchStatus }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(START)
  db.tables = {
    profiles: [{ id: APPROVER, display_name: 'Test Approver' }],
    entities: [{ code: 'EB-USA', xero_tenant_id: '0d0d0d0d-4444-4444-8444-0d0d0d0d0d0d' }],
    product_depot_mapping: [
      { depot_code: 'US-BAL', hubspot_sku_code: 'TSTPANEL', xero_item_code: 'TEST-PANEL', xero_item_description: 'Test panel', product_family: 'Test', is_active: true },
      { depot_code: 'US-BAL', hubspot_sku_code: 'TSTCLIP', xero_item_code: 'TEST-CLIP', xero_item_description: 'Test clip', product_family: 'Test', is_active: true },
    ],
    po_xero_sends: [],
  }
  db.rpcCalls = []
  db.capabilities = new Set(['po.approve'])
  db.userId = APPROVER
  db.afterUpdate = null
  db.writes = []
  fetchStatus = 200
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response('{}', { status: fetchStatus }))
  vi.stubGlobal('fetch', fetchMock)
  delete process.env.NEXT_PUBLIC_HUB_ENV
  process.env.N8N_PO_APPROVED_WEBHOOK_URL = HOOK_URL
  process.env.N8N_PO_APPROVED_WEBHOOK_SECRET = HOOK_SECRET
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env.N8N_PO_APPROVED_WEBHOOK_URL
  delete process.env.N8N_PO_APPROVED_WEBHOOK_SECRET
  delete process.env.NEXT_PUBLIC_HUB_ENV
})

// ---------------------------------------------------------------------------
// Gap 1: unpriced lines
// ---------------------------------------------------------------------------

describe('approving a leg with lines that have no unit price', () => {
  it('refuses until the lines are confirmed, before anything is approved or sent', async () => {
    seedLeg()
    const res = await decidePurchaseOrder({ poId: PO_ID, decision: 'approve' })
    expect(res.success).toBe(false)
    if (res.success) return
    expect(res.error).toContain('EBTST9001 has 1 line with no unit price: Test panel (TSTPANEL).')
    expect(res.error).toContain('Xero would receive it at 0')
    expect(res.unpricedLines?.map((l) => l.id)).toEqual([LINE_PANEL])
    expect(db.rpcCalls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a confirmation that does not cover every unpriced line', async () => {
    seedLeg({}, [
      { id: LINE_PANEL, po_id: PO_ID, sku: 'TSTPANEL', product_name: 'Test panel', quantity: 4, hs_code: null, unit_price: null },
      { id: LINE_CLIP, po_id: PO_ID, sku: 'TSTCLIP', product_name: 'Test clip', quantity: 10, hs_code: null, unit_price: 0 },
    ])
    const res = await decidePurchaseOrder({ poId: PO_ID, decision: 'approve', zeroPriceLineIds: [LINE_PANEL] })
    expect(res.success).toBe(false)
    expect(db.rpcCalls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('approves once the approver confirms exactly those lines, and Xero gets them as they are', async () => {
    seedLeg()
    const res = await decidePurchaseOrder({ poId: PO_ID, decision: 'approve', zeroPriceLineIds: [LINE_PANEL] })
    expect(res.success).toBe(true)
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['hub_approve_po_leg'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodies()[0].lines.map((l: Row) => [l.sku, l.unit_price])).toEqual([
      ['TSTPANEL', null],
      ['TSTCLIP', 3.5],
    ])
  })

  it('never asks on the manufacturing leg, which does not go to Xero', async () => {
    seedLeg({ leg: 'SRO_TO_SUPPLIER', from_entity: 'EB-SRO', to_entity: 'SUPPLIER' })
    const res = await decidePurchaseOrder({ poId: PO_ID, decision: 'approve' })
    expect(res.success).toBe(true)
    expect(db.rpcCalls).toHaveLength(1)
  })

  it('never holds up a rejection', async () => {
    seedLeg()
    const res = await decidePurchaseOrder({ poId: PO_ID, decision: 'reject', note: 'Not needed' })
    expect(res.success).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Gap 2: every outcome of the hand-off is recorded on the leg
// ---------------------------------------------------------------------------

describe('the hand-off after an approval', () => {
  const approve = () => decidePurchaseOrder({ poId: PO_ID, decision: 'approve', zeroPriceLineIds: [LINE_PANEL] })

  it('records an accepted send as the first attempt, and says nothing more', async () => {
    seedLeg()
    const res = await approve()
    expect(res.success && res.warning).toBeFalsy()
    expect(sends()).toEqual([
      expect.objectContaining({
        po_id: PO_ID,
        attempts: 1,
        last_outcome: 'accepted',
        last_error: null,
        last_attempt_by_uid: APPROVER,
        claimed_at: null,
      }),
    ])
  })

  it('carries the approver, the organisation, the item codes and the document', async () => {
    seedLeg()
    await approve()
    const [body] = bodies()
    expect(body).toMatchObject({
      po_id: PO_ID,
      po_number: 'EBTST9001',
      leg: 'DEPOT_TO_EB_GROUP',
      tier: 'Depot',
      approved_by: 'Test Approver',
      approved_by_uid: APPROVER,
      xero_tenant_id: '0d0d0d0d-4444-4444-8444-0d0d0d0d0d0d',
      raising_party: 'US-BAL',
      attachment: { filename: 'EBTST9001.pdf', content_base64: 'VEVTVA==' },
    })
    expect(body.lines.map((l: Row) => l.xero_item_code)).toEqual(['TEST-PANEL', 'TEST-CLIP'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(HOOK_URL)
    expect((init as RequestInit).headers).toMatchObject({ 'x-hub-secret': HOOK_SECRET })
  })

  it('records a refusal from n8n, tells the approver, and keeps the approval', async () => {
    seedLeg()
    fetchStatus = 500
    const res = await approve()
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.warning).toContain('the Depot order is NOT in Xero')
    expect(res.warning).toContain('HTTP 500')
    expect(res.warning).toContain('send it to Xero again')
    expect(sends()[0]).toMatchObject({ attempts: 1, last_outcome: 'failed', last_attempt_by_uid: APPROVER })
    expect(String(sends()[0].last_error)).toContain('HTTP 500')
    // What a screen shows is chosen from the status: never the address, never the secret.
    expect(JSON.stringify(sends()[0])).not.toContain('example.test')
    expect(JSON.stringify(sends()[0])).not.toContain(HOOK_SECRET)
  })

  it('records no answer at all, with the system code', async () => {
    seedLeg()
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    })
    const res = await approve()
    expect(res.success).toBe(true)
    expect(sends()[0]).toMatchObject({ last_outcome: 'failed', last_error: 'The Hub could not reach n8n (ECONNREFUSED).' })
  })

  it('gives up after the timeout and records it as timed out, because n8n may still finish', async () => {
    seedLeg()
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = approve()
    await vi.advanceTimersByTimeAsync(XERO_SEND_TIMEOUT_MS)
    const res = await pending
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.warning).toContain('may not be in Xero yet')
    expect(sends()[0]).toMatchObject({
      attempts: 1,
      last_outcome: 'timed_out',
      last_error: `n8n did not answer within ${XERO_SEND_TIMEOUT_MS / 1000} seconds.`,
    })
  })

  it('counts a missing webhook as a failure, where it used to pass in silence', async () => {
    seedLeg()
    delete process.env.N8N_PO_APPROVED_WEBHOOK_URL
    const res = await approve()
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.warning).toContain('NOT in Xero')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sends()[0]).toMatchObject({ attempts: 1, last_outcome: 'failed' })
    expect(String(sends()[0].last_error)).toContain('N8N_PO_APPROVED_WEBHOOK_URL is empty')
  })

  it('in the staging sandbox sends nothing, and marks the leg so the live Hub never offers to send it', async () => {
    seedLeg()
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    const res = await approve()
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.warning).toBe('Sandbox: Depot PO approved and saved in the Hub. The Xero hand-off is disabled in staging.')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sends()).toEqual([expect.objectContaining({ po_id: PO_ID, attempts: 0, last_outcome: null, sandbox_at: new Date(START).toISOString() })])
  })
})

// ---------------------------------------------------------------------------
// Send to Xero again
// ---------------------------------------------------------------------------

describe('sending a failed leg to Xero again', () => {
  const retry = (over: Partial<{ checkedXeroFor: string; attempts: number }> = {}) =>
    sendToXeroAgain({ poId: PO_ID, checkedXeroFor: 'EBTST9001', attempts: 1, ...over })

  it("re-posts the approval's own payload, document included, without approving again", async () => {
    seedLeg()
    fetchStatus = 500
    await decidePurchaseOrder({ poId: PO_ID, decision: 'approve', zeroPriceLineIds: [LINE_PANEL] })
    expect(sends()[0]).toMatchObject({ attempts: 1, last_outcome: 'failed' })

    // Somebody else presses, later.
    vi.setSystemTime(START + 30 * MIN)
    db.userId = SOMEONE_ELSE
    db.capabilities = new Set(['po.approve'])
    fetchStatus = 200
    const res = await retry()
    expect(res).toEqual({ ok: true, description: 'EBTST9001 was sent to Xero again, and n8n accepted it.' })

    const [first, second] = bodies()
    expect(second).toEqual(first)
    // The order's approver, not whoever pressed the button.
    expect(second.approved_by_uid).toBe(APPROVER)
    expect(fetchMock.mock.calls[1][0]).toBe(HOOK_URL)
    // Approving happened once, and only once.
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['hub_approve_po_leg'])
    expect(sends()[0]).toMatchObject({
      attempts: 2,
      last_outcome: 'accepted',
      last_error: null,
      last_attempt_by_uid: SOMEONE_ELSE,
      claimed_at: null,
    })
  })

  it('says so when it fails again, and records the second attempt', async () => {
    seedFailedSend()
    vi.setSystemTime(START + 2 * MIN)
    fetchStatus = 403
    const res = await retry()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('EBTST9001 is still not in Xero.')
    expect(res.error).toContain('HTTP 403')
    expect(sends()[0]).toMatchObject({ attempts: 2, last_outcome: 'failed', claimed_at: null })
  })

  it('needs po.approve', async () => {
    seedFailedSend()
    db.capabilities = new Set(['po.view'])
    const res = await retry()
    expect(res).toEqual({ ok: false, error: 'Forbidden: missing po.approve capability' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the staging note in the sandbox and sends and writes nothing', async () => {
    seedFailedSend()
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    const before = structuredClone(sends())
    const res = await retry()
    expect(res).toEqual({ ok: false, error: STAGING_SKIP_NOTE })
    expect(fetchMock).not.toHaveBeenCalled()
    // Not even a claim taken and handed back: nothing is written at all.
    expect(db.writes).toEqual([])
    expect(sends()).toEqual(before)
  })

  it('will not send until the approver says they looked for this number in Xero', async () => {
    seedFailedSend()
    for (const checkedXeroFor of ['', 'EBTST9002']) {
      const res = await retry({ checkedXeroFor })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error).toContain('Look for EBTST9001 in Xero first, drafts included')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sends()[0].claimed_at).toBeNull()
  })

  it('refuses a page that has gone stale since it was loaded', async () => {
    seedFailedSend({ attempts: 2 })
    const res = await retry({ attempts: 1 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('has been sent since this page was loaded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a leg Xero already holds', async () => {
    seedFailedSend()
    db.tables.purchase_orders[0].xero_po_id = '0e0e0e0e-5555-4555-8555-0e0e0e0e0e0e'
    const res = await retry()
    expect(res).toEqual({ ok: false, error: 'Xero already holds EBTST9001, so nothing was sent.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses while a send may still be on its way', async () => {
    // Accepted five minutes ago, timed out five minutes ago, or approved five minutes ago with
    // no record: each is inside the fifteen minutes n8n has to write the id back.
    for (const record of [
      { last_outcome: 'accepted', last_error: null, last_attempt_at: new Date(START - 5 * MIN).toISOString() },
      { last_outcome: 'timed_out', last_error: 'n8n did not answer within 25 seconds.', last_attempt_at: new Date(START - 5 * MIN).toISOString() },
    ]) {
      seedFailedSend(record)
      const res = await retry()
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error).toContain('Not sent again yet.')
    }
    seedFailedSend()
    db.tables.purchase_orders[0].approved_at = new Date(START - 5 * MIN).toISOString()
    db.tables.po_xero_sends = []
    const res = await retry({ attempts: 0 })
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends a leg approved in the staging sandbox', async () => {
    seedFailedSend({ attempts: 0, last_attempt_at: null, last_outcome: null, last_error: null, sandbox_at: new Date(START - 60 * MIN).toISOString() })
    const res = await retry({ attempts: 0 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('staging sandbox')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends the manufacturing leg', async () => {
    seedFailedSend()
    Object.assign(db.tables.purchase_orders[0], { leg: 'SRO_TO_SUPPLIER', from_entity: 'EB-SRO', to_entity: 'SUPPLIER' })
    const res = await retry()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('not a Depot or Group order')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends once when two approvers press together', async () => {
    seedFailedSend()
    vi.setSystemTime(START + 2 * MIN)
    const results = await Promise.all([retry(), retry()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)
    expect(loser && !loser.ok && loser.error).toContain('Somebody is sending EBTST9001 to Xero right now')
    expect(sends()[0]).toMatchObject({ attempts: 2, claimed_at: null })
  })

  it('stops, and gives the claim back, when n8n writes the id back while it claims', async () => {
    seedFailedSend()
    vi.setSystemTime(START + 2 * MIN)
    db.afterUpdate = (table, payload) => {
      if (table === 'po_xero_sends' && payload.claimed_at) {
        db.tables.purchase_orders[0].xero_po_id = '0f0f0f0f-6666-4666-8666-0f0f0f0f0f0f'
      }
    }
    const res = await retry()
    expect(res).toEqual({ ok: false, error: 'Xero already holds EBTST9001, so nothing was sent.' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sends()[0]).toMatchObject({ attempts: 1, claimed_at: null })
  })

  it('takes over a claim left by a server that stopped mid-send, once it is stale', async () => {
    seedFailedSend({ claimed_at: new Date(START - 20 * MIN).toISOString() })
    vi.setSystemTime(START + 2 * MIN)
    const res = await retry()
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sends()[0]).toMatchObject({ attempts: 2, claimed_at: null })
  })
})

// ---------------------------------------------------------------------------
// Where approvers look: the approvals page and the dashboard
// ---------------------------------------------------------------------------

describe('the list of approved orders that are not in Xero', () => {
  const approvedLeg = (id: string, over: Row): Row => ({
    id,
    po_number: `EBTST${id.slice(0, 4)}`,
    leg: 'DEPOT_TO_EB_GROUP',
    status: 'approved',
    source: 'hub',
    approved_at: new Date(START).toISOString(),
    xero_po_id: null,
    master_ref: 'MR-EBTST9001',
    ...over,
  })

  it("lists only this organisation's failed Depot and Group legs, newest approval first", async () => {
    vi.setSystemTime(START + 12 * MIN)
    db.tables.purchase_orders = [
      // Failed outright a minute after approval.
      approvedLeg('1a1a1a1a-0000-4000-8000-000000000001', {}),
      // In Xero.
      approvedLeg('2b2b2b2b-0000-4000-8000-000000000002', { leg: 'EB_GROUP_TO_SRO', xero_po_id: '9a9a9a9a-0000-4000-8000-000000000009' }),
      // Approved two minutes ago with no record: still waiting.
      approvedLeg('3c3c3c3c-0000-4000-8000-000000000003', { approved_at: new Date(START + 10 * MIN).toISOString(), master_ref: 'MR-EBTST9002' }),
      // The manufacturing leg never goes to Xero.
      approvedLeg('4d4d4d4d-0000-4000-8000-000000000004', { leg: 'SRO_TO_SUPPLIER' }),
      // Another organisation's chain.
      approvedLeg('5e5e5e5e-0000-4000-8000-000000000005', { master_ref: 'MR-ELSEWHERE' }),
      // A blank id written back an hour ago counts as missing.
      approvedLeg('6f6f6f6f-0000-4000-8000-000000000006', { xero_po_id: '', approved_at: new Date(START - 60 * MIN).toISOString(), master_ref: 'MR-EBTST9002' }),
      // Still waiting for approval.
      approvedLeg('7a7a7a7a-0000-4000-8000-000000000007', { status: 'requested', approved_at: null }),
    ]
    db.tables.po_xero_sends = [
      {
        ...SEND_DEFAULTS,
        po_id: '1a1a1a1a-0000-4000-8000-000000000001',
        attempts: 1,
        last_attempt_at: new Date(START + 1 * MIN).toISOString(),
        last_outcome: 'failed',
        last_error: 'n8n answered HTTP 422.',
      },
    ]

    const failures = await loadXeroSendFailures(
      client() as unknown as SupabaseClient,
      'master_ref.in.("MR-EBTST9001","MR-EBTST9002")',
    )
    expect(failures.map((f) => f.id)).toEqual(['1a1a1a1a-0000-4000-8000-000000000001', '6f6f6f6f-0000-4000-8000-000000000006'])
    expect(failures[0].message).toBe('Not in Xero: the send failed at 14:01 UTC on 2 Mar. n8n answered HTTP 422.')
    expect(failures[1].message).toContain('but no Xero purchase order came back')
  })

  it('reads nothing for an organisation that holds no chains', async () => {
    expect(await loadXeroSendFailures(client() as unknown as SupabaseClient, null)).toEqual([])
  })
})
