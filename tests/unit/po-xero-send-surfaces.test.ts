import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Where a purchase order that never reached Xero is said, and who can send it again.
 *
 * Dean's brief, 24 Sep 2026: show it plainly on the order page and on the board card, put it
 * where approvers look, and give po.approve holders a "Send to Xero again" button that asks them
 * to confirm they have looked in Xero first. These render the pieces on the server, the way the
 * pages do, and pin where each is used. Every value is invented.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/app/actions/purchase-orders/send-to-xero-again', () => ({ sendToXeroAgain: vi.fn() }))

import XeroSendNotice from '@/components/po/xero-send-notice'
import XeroSendFailures from '@/components/po/xero-send-failures'
import XeroSendCard from '@/app/(dashboard)/purchase-orders/[id]/xero-send-card'
import KanbanBoard from '@/components/board/KanbanBoard'
import type { XeroSendView } from '@/lib/po-xero-send'
import type { PurchaseOrder } from '@/lib/erp-types'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const FAILED: XeroSendView = {
  kind: 'failed',
  attempts: 1,
  message: 'Not in Xero: the send failed at 14:02 UTC on 2 Mar. n8n answered HTTP 422.',
}
const WAITING: XeroSendView = { kind: 'waiting', attempts: 1, message: 'Sent to Xero at 14:02 UTC on 2 Mar. Waiting for n8n to write the Xero purchase order back.' }

/** React escapes apostrophes and quotes in text; the tests read words, not entities. */
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&#x27;/g, "'")

describe('the order page', () => {
  const card = (view: XeroSendView, canApprove: boolean) =>
    html(
      createElement(XeroSendCard, {
        poId: '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a',
        poNumber: 'EBTST9001',
        view,
        xeroOrganisation: 'Echo Barrier USA LLC',
        canApprove,
      }),
    )

  it('says it plainly, and offers the retry behind the tick box to a po.approve holder', () => {
    const out = card(FAILED, true)
    expect(out).toContain(FAILED.message)
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('in Xero (Echo Barrier USA LLC), drafts included, and it is not there.')
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Send to Xero again<\/button>/)
    expect(out).toContain('n8n does not check Xero before it creates a purchase order')
  })

  it('offers nothing to press to somebody without po.approve, and says who can', () => {
    const out = card(FAILED, false)
    expect(out).toContain(FAILED.message)
    expect(out).not.toContain('Send to Xero again</button>')
    expect(out).toContain('Somebody with po.approve can send it to Xero again from this page.')
  })

  it('offers no retry while a send may still be on its way', () => {
    const out = card(WAITING, true)
    expect(out).toContain(WAITING.message)
    expect(out).not.toContain('type="checkbox"')
  })

  it('is rendered on the order page whenever the order carries a state', () => {
    const page = read('src/app/(dashboard)/purchase-orders/[id]/page.tsx')
    expect(page).toMatch(/\{po\.xero_send && \(\s*<XeroSendCard/)
    expect(page).toContain('canApprove={canApprove}')
  })
})

describe('the board card', () => {
  const order = (id: string, xero_send: XeroSendView | null): PurchaseOrder => ({
    id,
    po_number: `EBTST${id}`,
    parent_po_id: null,
    master_ref: `MR-EBTST${id}`,
    xero_po_id: null,
    xero_tenant_id: null,
    leg: 'DEPOT_TO_EB_GROUP',
    from_entity: 'US-BAL',
    to_entity: 'EB-GROUP',
    reference_po_number: null,
    status: 'approved',
    fulfilment_type: null,
    lifecycle_stage: null,
    notes: null,
    source: 'hub',
    delivery_address: null,
    requested_by: null,
    approved_by: 'Test Approver',
    decided_by: null,
    requested_by_uid: null,
    approved_by_uid: null,
    created_at: '2026-03-02T13:00:00.000Z',
    updated_at: '2026-03-02T13:00:00.000Z',
    approved_at: '2026-03-02T14:02:00.000Z',
    decided_at: null,
    shipped_at: null,
    delivered_at: null,
    lines: [],
    xero_send,
  })

  it('carries the failure in the words the order page uses, and nothing for a send still on its way', () => {
    const out = html(createElement(KanbanBoard, { orders: [order('9001', FAILED), order('9002', WAITING)] }))
    expect(out).toContain(FAILED.message)
    expect(out).not.toContain(WAITING.message)
  })
})

describe('where approvers look', () => {
  const failures = Array.from({ length: 7 }, (_, i) => ({
    id: `0a0a0a0a-0000-4000-8000-00000000000${i}`,
    po_number: `EBTST900${i}`,
    leg: 'DEPOT_TO_EB_GROUP',
    message: `Not in Xero: the send failed at 14:0${i} UTC on 2 Mar. n8n answered HTTP 500.`,
  }))

  it('lists each order with why, and links to the page that sends it again', () => {
    const out = html(createElement(XeroSendFailures, { failures: failures.slice(0, 2) }))
    expect(out).toContain('2 approved purchase orders are not in Xero')
    expect(out).toContain('href="/purchase-orders/0a0a0a0a-0000-4000-8000-000000000000"')
    expect(out).toContain(failures[1].message)
  })

  it('on the dashboard shows the first five and the way to the rest', () => {
    const out = html(createElement(XeroSendFailures, { failures, compact: true }))
    expect(out).toContain('7 approved purchase orders are not in Xero')
    expect(out).toContain('EBTST9004')
    expect(out).not.toContain('EBTST9005')
    expect(out).toContain('See all 7 on PO Approvals')
  })

  it('says nothing at all when nothing failed', () => {
    expect(html(createElement(XeroSendFailures, { failures: [] }))).toBe('')
  })

  it('is on the approvals page and on the dashboard, for po.approve holders', () => {
    const approvals = code('src/app/(dashboard)/purchase-orders/approvals/page.tsx')
    expect(approvals).toContain('loadXeroSendFailures(supabase, filter)')
    expect(approvals).toContain('<XeroSendFailures failures={failures} />')
    const dashboard = code('src/app/(dashboard)/page.tsx')
    expect(dashboard).toMatch(/caps\.has\('po\.approve'\) && \(\s*<Suspense fallback=\{null\}>\s*<XeroSendBanner \/>/)
    expect(code('src/components/po/xero-send-banner.tsx')).toContain("auth.capabilities.has('po.approve')")
  })

  it('renders the notice as an alert when the send failed', () => {
    expect(html(createElement(XeroSendNotice, { view: FAILED }))).toContain('role="alert"')
    expect(html(createElement(XeroSendNotice, { view: WAITING }))).not.toContain('role="alert"')
  })
})

describe('the retry is one gated endpoint', () => {
  const src = code('src/app/actions/purchase-orders/send-to-xero-again.ts')

  it('exports only the action, which checks po.approve and the organisation that holds the chain', () => {
    expect([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1])).toEqual(['sendToXeroAgain'])
    expect(src).toContain('auth.capabilities.has("po.approve")')
    expect(src).toContain('poChainHeldBy(poId, auth.profile.organisations)')
  })

  it('keeps the hand-off out of the endpoints: it is server-only, not use server', () => {
    const handoff = read('src/app/actions/purchase-orders/xero-handoff.ts')
    expect(handoff.startsWith('import "server-only";')).toBe(true)
    expect(handoff).not.toMatch(/^["']use server["']/m)
  })
})
