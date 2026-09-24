import { describe, it, expect } from 'vitest'
import {
  XERO_SEND_GRACE_MS,
  belongsInXero,
  describeLines,
  hasXeroId,
  unpricedLines,
  unpricedRefusal,
  whenUtc,
  xeroOrganisationName,
  xeroSendView,
  type XeroSendLeg,
  type XeroSendRecord,
} from '@/lib/po-xero-send'

/**
 * When an approved purchase order leg counts as not in Xero, and what the Hub says about it.
 *
 * 24 Sep 2026: a failed hand-off to n8n used to raise a toast and nothing else, and the order
 * could never be sent again. These pin the rules every screen and the retry share. Every value
 * here is invented.
 */

const APPROVED_AT = '2026-03-02T14:02:00.000Z'
const T0 = Date.parse(APPROVED_AT)
const MIN = 60_000

const leg = (over: Partial<XeroSendLeg> = {}): XeroSendLeg => ({
  leg: 'DEPOT_TO_EB_GROUP',
  source: 'hub',
  status: 'approved',
  approved_at: APPROVED_AT,
  xero_po_id: null,
  ...over,
})

const record = (over: Partial<XeroSendRecord> = {}): XeroSendRecord => ({
  po_id: '11111111-2222-4333-8444-555555555555',
  attempts: 1,
  last_attempt_at: APPROVED_AT,
  last_outcome: 'accepted',
  last_error: null,
  claimed_at: null,
  sandbox_at: null,
  ...over,
})

describe('which legs belong in Xero', () => {
  it('the Depot and Group legs, once approved and raised in the Hub', () => {
    expect(belongsInXero(leg())).toBe(true)
    expect(belongsInXero(leg({ leg: 'EB_GROUP_TO_SRO', status: 'in_manufacturing' }))).toBe(true)
  })

  it('never the manufacturing leg, which is not sent to Xero by design', () => {
    const sro = leg({ leg: 'SRO_TO_SUPPLIER' })
    expect(belongsInXero(sro)).toBe(false)
    // Hours after approval with no Xero id, it is still not flagged.
    expect(xeroSendView(sro, null, T0 + 600 * MIN)).toBeNull()
    expect(xeroSendView(sro, record({ last_outcome: 'failed', last_error: 'Refused.' }), T0 + 600 * MIN)).toBeNull()
  })

  it('never a leg that was not approved, was rejected or cancelled, or came from Xero itself', () => {
    for (const status of ['requested', 'rejected', 'cancelled']) {
      expect(xeroSendView(leg({ status }), null, T0 + 600 * MIN), status).toBeNull()
    }
    expect(xeroSendView(leg({ approved_at: null }), null, T0 + 600 * MIN)).toBeNull()
    expect(xeroSendView(leg({ source: 'n8n' }), null, T0 + 600 * MIN)).toBeNull()
  })
})

describe('the Xero id is the proof', () => {
  it('wins over anything the Hub recorded, because a failed send can still have finished', () => {
    const inXero = leg({ xero_po_id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' })
    expect(hasXeroId(inXero)).toBe(true)
    expect(xeroSendView(inXero, record({ last_outcome: 'failed', last_error: 'Refused.' }), T0 + 600 * MIN)).toBeNull()
  })

  it('counts a blank id as missing', () => {
    expect(hasXeroId(leg({ xero_po_id: '' }))).toBe(false)
    expect(xeroSendView(leg({ xero_po_id: '' }), null, T0 + 16 * MIN)?.kind).toBe('failed')
  })
})

describe('a send that failed outright', () => {
  it('is failed at once, says when and why, and counts the sends', () => {
    const view = xeroSendView(
      leg(),
      record({ attempts: 2, last_outcome: 'failed', last_error: 'The n8n workflow stopped with an error (HTTP 500).' }),
      T0 + 1 * MIN,
    )
    expect(view).toEqual({
      kind: 'failed',
      attempts: 2,
      message: 'Not in Xero: the send failed at 14:02 UTC on 2 Mar. The n8n workflow stopped with an error (HTTP 500). Sent 2 times.',
    })
  })
})

describe('the 15 minute rule: n8n may take the order and fail inside', () => {
  it('waits, then fails, from the approval when the Hub holds no record of a send', () => {
    expect(xeroSendView(leg(), null, T0 + 14 * MIN)?.kind).toBe('waiting')
    const failed = xeroSendView(leg(), null, T0 + 16 * MIN)
    expect(failed?.kind).toBe('failed')
    expect(failed?.message).toBe('Not in Xero: approved at 14:02 UTC on 2 Mar, but no Xero purchase order came back.')
  })

  it('waits, then fails, from a send n8n accepted', () => {
    const accepted = record({ last_attempt_at: '2026-03-02T15:00:00.000Z' })
    expect(xeroSendView(leg(), accepted, Date.parse('2026-03-02T15:14:00Z'))?.kind).toBe('waiting')
    const failed = xeroSendView(leg(), accepted, Date.parse('2026-03-02T15:16:00Z'))
    expect(failed?.kind).toBe('failed')
    expect(failed?.message).toContain('n8n took the order at 15:00 UTC on 2 Mar, but no Xero purchase order came back')
  })

  it('treats a timed-out send as maybe still running, and says until when', () => {
    const timedOut = record({ last_outcome: 'timed_out', last_error: 'n8n did not answer within 25 seconds.' })
    const waiting = xeroSendView(leg(), timedOut, T0 + 5 * MIN)
    expect(waiting?.kind).toBe('waiting')
    expect(waiting?.message).toContain('n8n did not answer within 25 seconds.')
    expect(waiting?.message).toContain('by 14:17 UTC')
    expect(xeroSendView(leg(), timedOut, T0 + XERO_SEND_GRACE_MS + 1)?.kind).toBe('failed')
  })

  it('treats a retry that claimed the leg and never reported back the same way', () => {
    const claimed = record({ claimed_at: '2026-03-02T16:00:00.000Z', last_outcome: 'failed', last_error: 'Refused.' })
    const waiting = xeroSendView(leg(), claimed, Date.parse('2026-03-02T16:05:00Z'))
    expect(waiting?.kind).toBe('waiting')
    expect(waiting?.message).toBe('Being sent to Xero again since 16:00 UTC on 2 Mar.')
    const failed = xeroSendView(leg(), claimed, Date.parse('2026-03-02T16:16:00Z'))
    expect(failed?.kind).toBe('failed')
    expect(failed?.message).toContain('a send started at 16:00 UTC on 2 Mar and never reported back')
  })
})

describe('the staging sandbox', () => {
  it('is its own state, never a failure, because it never sent anything', () => {
    const view = xeroSendView(
      leg(),
      record({ attempts: 0, last_attempt_at: null, last_outcome: null, sandbox_at: APPROVED_AT }),
      T0 + 600 * MIN,
    )
    expect(view?.kind).toBe('sandbox')
    expect(view?.message).toContain('staging sandbox')
  })
})

describe('the words', () => {
  it('always give the time in UTC and say so', () => {
    expect(whenUtc('2026-11-30T09:05:00.000Z')).toBe('09:05 UTC on 30 Nov')
  })

  it('never carry an em-dash', () => {
    const views = [
      xeroSendView(leg(), null, T0 + 16 * MIN),
      xeroSendView(leg(), null, T0 + 1 * MIN),
      xeroSendView(leg(), record({ last_outcome: 'failed', last_error: 'Refused.' }), T0),
      xeroSendView(leg(), record({ last_outcome: 'timed_out', last_error: 'Slow.' }), T0),
      xeroSendView(leg(), record({ attempts: 0, last_attempt_at: null, last_outcome: null, sandbox_at: APPROVED_AT }), T0),
    ]
    for (const view of views) expect(view?.message).not.toContain('\u2014')
  })

  it('name the Xero organisation to look in by its legal name', () => {
    expect(xeroOrganisationName({ from_entity: 'US-BAL' })).toBe('Echo Barrier USA LLC')
    expect(xeroOrganisationName({ from_entity: 'EB-GROUP' })).toBe('Echo Barrier Group Limited')
    expect(xeroOrganisationName({ from_entity: 'NOWHERE' })).toBeNull()
  })
})

describe('lines with no unit price', () => {
  const line = (id: string, unit_price: number | null, product_name: string | null = `Test panel ${id}`) => ({
    id,
    sku: `TST${id}`,
    product_name,
    unit_price,
  })

  it('are the ones n8n would send at 0: null, zero, and anything not above zero', () => {
    const lines = [line('1', null), line('2', 0), line('3', 12.5), line('4', -1), line('5', '0' as unknown as number)]
    expect(unpricedLines(lines).map((l) => l.id)).toEqual(['1', '2', '4', '5'])
  })

  it('are named by product first, with the SKU to find them by', () => {
    expect(describeLines(unpricedLines([line('1', null), line('2', null, null)]))).toBe('Test panel 1 (TST1), TST2')
  })

  it('refuse in words that name the lines and say what Xero would receive', () => {
    const text = unpricedRefusal('EBTST9001', unpricedLines([line('1', null), line('2', 0)]))
    expect(text).toContain('EBTST9001 has 2 lines with no unit price: Test panel 1 (TST1), Test panel 2 (TST2).')
    expect(text).toContain('Xero would receive them at 0')
    expect(text).toContain('Approve with these lines at 0 in Xero')
    expect(text).not.toContain('\u2014')
  })
})
