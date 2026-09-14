import { describe, it, expect } from 'vitest'
import {
  authorizeBearer,
  parseAgentQuoteBody,
  checkProductsAllowed,
  checkProductSkus,
  checkDealProgress,
  checkDealShape,
  checkListPriced,
  amountCeiling,
  checkAmountCeiling,
  checkCaps,
  checkUrgentCap,
  acceptByFrom,
  hasLapsed,
  formatSydneyDeadline,
  urgentCommentLine,
  quoteComments,
  urgentPerUnitDiscounts,
  linesFromRow,
  linesKey,
  mergeLines,
  isUuid,
  hasAmountMismatch,
  quoteReferenceOf,
  ANZ_QUOTATION_SENT_STAGE,
  CODE_STATUS,
  AGENT_QUOTE_COMMENTS,
  urgentExpiryDate,
  type DealShape,
} from '@/lib/agent-quote/guards'

/**
 * Guards for POST /api/agent/quote. Contract C1 in the Jack quotes plan.
 * Every refusal here happens before a single HubSpot write.
 */

const H9 = '1640186928'
const H10 = '29231439287'
const H8 = '29207461216'
const H9X = '19850990926'
const HOOKS = '29207708995'
const BUNGEES = '29231439368'

const base = { action: 'create', conversationId: 'conv_abc123', dealId: '64951402250', pricing: 'list' }

describe('authorizeBearer', () => {
  const SECRET = 'a'.repeat(64)
  const PREVIOUS = 'b'.repeat(64)

  it('refuses everything when neither secret is set (fails closed)', () => {
    expect(authorizeBearer('Bearer ', {})).toBe(false)
    expect(authorizeBearer('', {})).toBe(false)
    expect(authorizeBearer(null, {})).toBe(false)
    expect(authorizeBearer('Bearer undefined', {})).toBe(false)
    expect(authorizeBearer('Bearer ', { AGENT_QUOTE_SECRET: '', AGENT_QUOTE_SECRET_PREVIOUS: '   ' })).toBe(false)
  })

  it('accepts the current secret', () => {
    expect(authorizeBearer(`Bearer ${SECRET}`, { AGENT_QUOTE_SECRET: SECRET })).toBe(true)
  })

  it('accepts the previous secret during a rotation', () => {
    expect(authorizeBearer(`Bearer ${PREVIOUS}`, { AGENT_QUOTE_SECRET: SECRET, AGENT_QUOTE_SECRET_PREVIOUS: PREVIOUS })).toBe(true)
    expect(authorizeBearer(`Bearer ${PREVIOUS}`, { AGENT_QUOTE_SECRET_PREVIOUS: PREVIOUS })).toBe(true)
  })

  it('refuses a wrong secret, a missing header, or the secret without the Bearer prefix', () => {
    const env = { AGENT_QUOTE_SECRET: SECRET, AGENT_QUOTE_SECRET_PREVIOUS: PREVIOUS }
    expect(authorizeBearer(`Bearer ${'c'.repeat(64)}`, env)).toBe(false)
    expect(authorizeBearer(null, env)).toBe(false)
    expect(authorizeBearer(SECRET, env)).toBe(false)
    expect(authorizeBearer(`Bearer ${SECRET} `, env)).toBe(false)
  })
})

describe('parseAgentQuoteBody', () => {
  const lines = (n: number, quantity = 1) =>
    [H8, H9, H9X, H10, HOOKS, BUNGEES, '1'].slice(0, n).map((productId) => ({ productId, quantity }))

  it('accepts a valid create and a valid mark_sent', () => {
    const create = parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity: 40 }] })
    expect(create.ok).toBe(true)
    const mark = parseAgentQuoteBody({ action: 'mark_sent', conversationId: 'conv_x1', dealId: '1' })
    expect(mark).toEqual({ ok: true, value: { action: 'mark_sent', conversationId: 'conv_x1', dealId: '1' } })
  })

  it('refuses an extra key at the top level, on a line, and on mark_sent', () => {
    expect(parseAgentQuoteBody({ ...base, lines: lines(1), comments: 'hi' })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity: 1, unitPrice: 1 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ action: 'mark_sent', conversationId: 'conv_x', dealId: '1', lines: [] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('refuses a malformed conversation id, deal id or action', () => {
    for (const conversationId of ['exec-123', 'conv_', 'test-trun_abc', 'conv_a-b', '']) {
      expect(parseAgentQuoteBody({ ...base, conversationId, lines: lines(1) }).ok).toBe(false)
    }
    expect(parseAgentQuoteBody({ ...base, dealId: '64951402250x', lines: lines(1) }).ok).toBe(false)
    expect(parseAgentQuoteBody({ ...base, dealId: 64951402250, lines: lines(1) }).ok).toBe(false)
    expect(parseAgentQuoteBody({ ...base, action: 'delete', lines: lines(1) }).ok).toBe(false)
    expect(parseAgentQuoteBody(null).ok).toBe(false)
    expect(parseAgentQuoteBody('create').ok).toBe(false)
  })

  it('allows 6 lines and refuses 7 and 0', () => {
    expect(parseAgentQuoteBody({ ...base, lines: lines(6) }).ok).toBe(true)
    expect(parseAgentQuoteBody({ ...base, lines: lines(7) })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, lines: [] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('allows 200 panels in total and refuses 201', () => {
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity: 150 }, { productId: H10, quantity: 50 }] }).ok).toBe(true)
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity: 150 }, { productId: H10, quantity: 51 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H8, quantity: 201 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('does not count hooks and bungees as panels, but caps each line at 400', () => {
    // 200 panels with a fitting kit: 200 hooks and 400 bungees.
    const kit = [{ productId: H9, quantity: 200 }, { productId: HOOKS, quantity: 200 }, { productId: BUNGEES, quantity: 400 }]
    expect(parseAgentQuoteBody({ ...base, lines: kit }).ok).toBe(true)
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: BUNGEES, quantity: 401 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('refuses quantities that are zero, negative, fractional or strings', () => {
    for (const quantity of [0, -1, 1.5, '4', Number.NaN]) {
      expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity }] }).ok).toBe(false)
    }
  })

  it('merges repeated products and applies the limits to the merged figure', () => {
    const merged = parseAgentQuoteBody({ ...base, lines: [{ productId: HOOKS, quantity: 10 }, { productId: H9, quantity: 10 }, { productId: HOOKS, quantity: 5 }] })
    expect(merged).toEqual({ ok: true, value: { ...base, lines: [{ productId: HOOKS, quantity: 15 }, { productId: H9, quantity: 10 }] } })
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: BUNGEES, quantity: 300 }, { productId: BUNGEES, quantity: 101 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, lines: [{ productId: H9, quantity: 150 }, { productId: H9, quantity: 51 }] })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })
})

describe('products', () => {
  it('allows exactly the six ANZ products', () => {
    expect(checkProductsAllowed([H8, H9, H9X, H10, HOOKS, BUNGEES].map((productId) => ({ productId, quantity: 1 })))).toBeNull()
    expect(checkProductsAllowed([{ productId: H9, quantity: 1 }, { productId: '12345', quantity: 1 }])).toBe('PRODUCT_NOT_ALLOWED')
  })

  it('refuses a product whose HubSpot SKU is not the expected one', () => {
    const lines = [{ productId: H9, quantity: 1 }]
    expect(checkProductSkus(lines, { [H9]: 'EBH9NA' })).toBeNull()
    expect(checkProductSkus(lines, { [H9]: 'EBH9' })).toBe('PRODUCT_NOT_ALLOWED')
    expect(checkProductSkus(lines, {})).toBe('PRODUCT_NOT_ALLOWED')
  })

  it('keys lines independent of order and merges duplicates', () => {
    expect(linesKey([{ productId: H9, quantity: 4 }, { productId: HOOKS, quantity: 4 }])).toBe(
      linesKey([{ productId: HOOKS, quantity: 2 }, { productId: H9, quantity: 4 }, { productId: HOOKS, quantity: 2 }]),
    )
    expect(linesKey([{ productId: H9, quantity: 4 }])).not.toBe(linesKey([{ productId: H9, quantity: 5 }]))
    expect(mergeLines([])).toEqual([])
  })
})

describe('checkDealShape', () => {
  const good: DealShape = {
    pipeline: '14520121',
    dealstage: '39459179',
    hubspot_owner_id: '30234944',
    deal_currency_code: 'AUD',
    contactIds: ['247940140576'],
  }

  it('passes the fixture deal shape', () => {
    expect(checkDealShape(good)).toBeNull()
    for (const dealstage of ['39459178', '39459180', '39459181', '39459182']) {
      expect(checkDealShape({ ...good, dealstage })).toBeNull()
    }
  })

  it('refuses another pipeline', () => {
    expect(checkDealShape({ ...good, pipeline: 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc' })).toBe('NOT_ANZ_DEAL')
    expect(checkDealShape({ ...good, pipeline: null })).toBe('NOT_ANZ_DEAL')
  })

  it('refuses won and lost deals, and unknown stages', () => {
    expect(checkDealShape({ ...good, dealstage: '39459183' })).toBe('DEAL_CLOSED')
    expect(checkDealShape({ ...good, dealstage: '39459184' })).toBe('DEAL_CLOSED')
    expect(checkDealShape({ ...good, dealstage: '1216646' })).toBe('BAD_STAGE')
    expect(checkDealShape({ ...good, dealstage: '' })).toBe('BAD_STAGE')
  })

  it('refuses another owner', () => {
    expect(checkDealShape({ ...good, hubspot_owner_id: '123' })).toBe('WRONG_OWNER')
    expect(checkDealShape({ ...good, hubspot_owner_id: undefined })).toBe('WRONG_OWNER')
  })

  it('refuses non-AUD, including a blank currency that createQuote would price as USD', () => {
    expect(checkDealShape({ ...good, deal_currency_code: 'USD' })).toBe('NOT_AUD')
    expect(checkDealShape({ ...good, deal_currency_code: '' })).toBe('NOT_AUD')
    expect(checkDealShape({ ...good, deal_currency_code: null })).toBe('NOT_AUD')
    expect(checkDealShape({ ...good, deal_currency_code: ' aud ' })).toBeNull()
  })

  it('refuses two contacts and none', () => {
    expect(checkDealShape({ ...good, contactIds: ['1', '2'] })).toBe('CONTACT_COUNT')
    expect(checkDealShape({ ...good, contactIds: [] })).toBe('CONTACT_COUNT')
  })
})

describe('checkDealProgress', () => {
  const good = { pipeline: '14520121', dealstage: '39459179', hubspot_owner_id: '30234944' }

  it('asks only whether the deal has moved on, which is what a REPEAT turns on', () => {
    expect(checkDealProgress(good)).toBeNull()
    expect(checkDealProgress({ ...good, pipeline: '14356619' })).toBe('NOT_ANZ_DEAL')
    expect(checkDealProgress({ ...good, dealstage: '39459183' })).toBe('DEAL_CLOSED')
    expect(checkDealProgress({ ...good, dealstage: '39459184' })).toBe('DEAL_CLOSED')
    expect(checkDealProgress({ ...good, dealstage: '1216646' })).toBe('BAD_STAGE')
    expect(checkDealProgress({ ...good, hubspot_owner_id: '123' })).toBe('WRONG_OWNER')
  })

  it('narrows to one stage for a reissue, exactly as checkDealShape does', () => {
    expect(checkDealProgress({ ...good, dealstage: '39459182' }, [ANZ_QUOTATION_SENT_STAGE])).toBeNull()
    expect(checkDealProgress(good, [ANZ_QUOTATION_SENT_STAGE])).toBe('BAD_STAGE')
  })

  it('is the front half of checkDealShape, so the two can never disagree', () => {
    const shaped: DealShape = { ...good, deal_currency_code: 'AUD', contactIds: ['1'] }
    for (const dealstage of ['39459178', '39459182', '39459183', '1216646']) {
      const progress = checkDealProgress({ ...shaped, dealstage })
      if (progress) expect(checkDealShape({ ...shaped, dealstage })).toBe(progress)
    }
    // And the back half is the part a repeat deliberately skips.
    expect(checkDealProgress(good)).toBeNull()
    expect(checkDealShape({ ...shaped, deal_currency_code: 'USD' })).toBe('NOT_AUD')
    expect(checkDealShape({ ...shaped, contactIds: [] })).toBe('CONTACT_COUNT')
  })
})

describe('pricing and amount', () => {
  const listLine = { priceSource: 'list' as const, priced: { listUnitPrice: 120, netUnitPrice: 120, registry: { unit_price: 120, discount_percentage: 0 }, hubspot: { price: 120 } } }

  it('accepts only list-priced lines with a positive price', () => {
    expect(checkListPriced([listLine, listLine])).toBeNull()
    expect(checkListPriced([listLine, { ...listLine, priceSource: 'manual' as const }])).toBe('NO_PRICE')
    expect(checkListPriced([{ ...listLine, priceSource: 'contract' as const }])).toBe('NO_PRICE')
    expect(checkListPriced([{ ...listLine, priced: { ...listLine.priced, listUnitPrice: 0 } }])).toBe('NO_PRICE')
    expect(checkListPriced([])).toBe('NO_PRICE')
  })

  it('reads the ceiling from env, defaulting to 50000 for blank or junk', () => {
    expect(amountCeiling(undefined)).toBe(50000)
    expect(amountCeiling('')).toBe(50000)
    expect(amountCeiling('abc')).toBe(50000)
    expect(amountCeiling('-5')).toBe(50000)
    expect(amountCeiling('0')).toBe(50000)
    expect(amountCeiling('30000')).toBe(30000)
  })

  it('holds a quote above the ceiling, not at it', () => {
    expect(checkAmountCeiling(50000, 50000)).toBeNull()
    expect(checkAmountCeiling(50000.01, 50000)).toBe('AMOUNT_CEILING')
    expect(checkAmountCeiling(Number.NaN, 50000)).toBe('AMOUNT_CEILING')
  })

  it('flags an amount mismatch with the SAME rule the publish tail uses', () => {
    // CREATED takes amountMismatch from quote-publish-tail, REPEAT computes it
    // here, and the Sender holds the email when it is true. Two rules meant one
    // call could hold and its retry could send: this one is character for
    // character the tail's `amount != null && Math.abs(amount - hubAmount) >
    // 0.01`, so they cannot disagree, boundary included.
    const tail = (amount: number | string | null, hubAmount: number | string | null) =>
      amount != null && hubAmount != null && Math.abs(Number(amount) - Number(hubAmount)) > 0.01
    for (const [a, b] of [[100, 100.01], [100.01, 100], ['100', '100.02'], [4999.99, 5000], [100, 100], [10200, 10200.005]] as const) {
      expect(hasAmountMismatch(a, b)).toBe(tail(a, b))
    }
    expect(hasAmountMismatch(null, 100)).toBe(false)
    expect(hasAmountMismatch(100, undefined)).toBe(false)
  })
})

describe('caps, ids and fixed values', () => {
  it('caps at 3 per deal per 7 days and 20 per day', () => {
    expect(checkCaps({ dealLast7Days: 2, allLast24Hours: 19 })).toBeNull()
    expect(checkCaps({ dealLast7Days: 3, allLast24Hours: 0 })).toBe('CAP_REACHED')
    expect(checkCaps({ dealLast7Days: 0, allLast24Hours: 20 })).toBe('CAP_REACHED')
  })

  it('accepts only a uuid for JACK_USER_ID', () => {
    expect(isUuid('7d6c2a3e-1b4f-4a8e-9c0d-2e3f4a5b6c7d')).toBe(true)
    expect(isUuid('7d6c2a3e-1b4f-4a8e-9c0d-2e3f4a5b6c7d,created_by_uid.is.null')).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })

  it('derives the quote reference from a suffixed quote number', () => {
    expect(quoteReferenceOf('BA202600123')).toBe('BA202600123')
    expect(quoteReferenceOf('BA202600123-2')).toBe('BA202600123')
    expect(quoteReferenceOf(null)).toBeNull()
  })

  it('maps every code to the contract status', () => {
    expect(CODE_STATUS.UNAUTHORIZED).toBe(401)
    expect(CODE_STATUS.BAD_REQUEST).toBe(400)
    expect(CODE_STATUS.NOT_BOUND).toBe(403)
    for (const c of ['CAP_REACHED', 'IN_PROGRESS', 'URGENT_CAP', 'REISSUE_CAP'] as const) {
      expect(CODE_STATUS[c]).toBe(409)
    }
    for (const c of ['NOT_ANZ_DEAL', 'DEAL_CLOSED', 'BAD_STAGE', 'WRONG_OWNER', 'NOT_AUD', 'CONTACT_COUNT', 'CONTRACT_CUSTOMER', 'FOREIGN_QUOTE', 'PRODUCT_NOT_ALLOWED', 'NO_PRICE', 'NO_FLOOR', 'DISCOUNT_REFUSED', 'AMOUNT_CEILING', 'TEMPLATE_MISSING', 'NO_JACK_QUOTE', 'NO_URGENT_QUOTE', 'NOT_LAPSED'] as const) {
      expect(CODE_STATUS[c]).toBe(422)
    }
    expect(CODE_STATUS.QUOTE_PUBLISH_FAILED).toBe(502)
    expect(CODE_STATUS.HUBSPOT_ERROR).toBe(502)
    expect(CODE_STATUS.INTERNAL).toBe(500)
  })

  it('prints fixed ASCII comments', () => {
    expect(AGENT_QUOTE_COMMENTS).toEqual(['Prices in Australian dollars, excluding GST.', 'Freight is quoted separately.'])
    expect(AGENT_QUOTE_COMMENTS.join('\n')).toMatch(/^[\x20-\x7e\n]+$/)
  })
})

// ---------------------------------------------------------------------------
// Urgent floor pricing (urgent-pricing.md, Dean 2026-09-14)
// ---------------------------------------------------------------------------

describe('urgent pricing: the body', () => {
  const lines = [{ productId: H10, quantity: 4 }]

  it('requires a pricing mode on every create', () => {
    expect(parseAgentQuoteBody({ action: 'create', conversationId: 'conv_a1', dealId: '1', lines })).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    })
    expect(parseAgentQuoteBody({ ...base, pricing: 'cheap', lines }).ok).toBe(false)
  })

  it('needs the urgency note for urgent, and refuses one on a list quote', () => {
    const urgent = parseAgentQuoteBody({ ...base, pricing: 'urgent', urgencyNote: 'site starts Monday', lines })
    expect(urgent).toEqual({
      ok: true,
      value: { ...base, pricing: 'urgent', urgencyNote: 'site starts Monday', lines },
    })
    expect(parseAgentQuoteBody({ ...base, pricing: 'urgent', lines })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, pricing: 'urgent', urgencyNote: '   ', lines })).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(parseAgentQuoteBody({ ...base, urgencyNote: 'site starts Monday', lines })).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('caps the urgency note at 200 characters', () => {
    expect(parseAgentQuoteBody({ ...base, pricing: 'urgent', urgencyNote: 'x'.repeat(200), lines }).ok).toBe(true)
    expect(parseAgentQuoteBody({ ...base, pricing: 'urgent', urgencyNote: 'x'.repeat(201), lines }).ok).toBe(false)
  })

  it('accepts a reissue with a deal id and nothing else', () => {
    expect(parseAgentQuoteBody({ action: 'reissue', dealId: '64951402250' })).toEqual({
      ok: true,
      value: { action: 'reissue', dealId: '64951402250' },
    })
    // No conversation is needed, and none is accepted: the lapsed urgent quote
    // on the deal is the binding.
    expect(parseAgentQuoteBody({ action: 'reissue', dealId: '1', conversationId: 'conv_a1' }).ok).toBe(false)
    expect(parseAgentQuoteBody({ action: 'reissue', dealId: '1', lines }).ok).toBe(false)
    expect(parseAgentQuoteBody({ action: 'reissue', dealId: 'x' }).ok).toBe(false)
  })
})

describe('urgent pricing: the floor maths', () => {
  const line = (listUnitPrice: number, floorPrice: number | null) => ({
    priced: { listUnitPrice, netUnitPrice: listUnitPrice, registry: { unit_price: listUnitPrice, discount_percentage: 0 }, hubspot: { price: listUnitPrice } },
    floorPrice,
  })

  it('takes each line from its unit price down to its floor', () => {
    // The live H10 numbers: 275.00 unit, 205.00 floor.
    expect(urgentPerUnitDiscounts([line(275, 205), line(3, 2), line(1.5, 1)])).toEqual([70, 1, 0.5])
  })

  it('gives 0, not a discount, when the floor IS the unit price', () => {
    expect(urgentPerUnitDiscounts([line(275, 275)])).toEqual([0])
  })

  it('refuses the whole quote when any line has no floor', () => {
    expect(urgentPerUnitDiscounts([line(275, 205), line(3, null)])).toBeNull()
    expect(urgentPerUnitDiscounts([line(275, undefined as unknown as null)])).toBeNull()
    expect(urgentPerUnitDiscounts([])).toBeNull()
  })

  it('refuses a floor above the unit price or below zero, which the view does not enforce', () => {
    expect(urgentPerUnitDiscounts([line(275, 300)])).toBeNull()
    expect(urgentPerUnitDiscounts([line(275, -1)])).toBeNull()
  })

  it('refuses a ZERO floor rather than quoting the line at nothing', () => {
    // list_prices_check permits floor_price = 0, and it is the one permitted
    // value that would discount the whole unit price away. The floor test
    // downstream asks whether the net is BELOW the floor, and 0 is not below 0,
    // so nothing else in the Hub would refuse a free quote.
    expect(urgentPerUnitDiscounts([line(275, 0)])).toBeNull()
    expect(urgentPerUnitDiscounts([line(275, 205), line(3, 0)])).toBeNull()
    // A sub-cent floor rounds to zero and is the same quote.
    expect(urgentPerUnitDiscounts([line(275, 0.004)])).toBeNull()
    // One cent is a real floor, however daft, and is quoted as one.
    expect(urgentPerUnitDiscounts([line(275, 0.01)])).toEqual([274.99])
  })
})

describe('urgent pricing: the HubSpot expiry date', () => {
  it('is the SYDNEY calendar date of the acceptance deadline', () => {
    // 05:15 UTC on 15 September is 3:15pm that afternoon in Sydney.
    expect(urgentExpiryDate('2026-09-15T05:15:00.000Z')).toBe('2026-09-15')
  })

  it('does not expire a day early for a quote raised before 10am Sydney', () => {
    // The finding, in one assertion. A quote raised 09:10 Sydney on Wednesday
    // 16 September is 23:10 UTC on the 15th, so the UTC date is still the 15th
    // and "UTC date plus one day" would have said 2026-09-16, a full calendar
    // day before the 09:10 Thursday deadline printed on that same quote.
    const acceptBy = '2026-09-16T23:10:00.000Z'
    expect(formatSydneyDeadline(acceptBy)).toBe('9:10am Thursday 17 September 2026')
    expect(urgentExpiryDate(acceptBy)).toBe('2026-09-17')
  })

  it('agrees with the printed deadline on the other side of the UTC day boundary', () => {
    // 04:00 UTC is 2pm Sydney the same UTC day, the case that happened to work.
    const acceptBy = '2026-09-17T04:00:00.000Z'
    expect(formatSydneyDeadline(acceptBy)).toBe('2:00pm Thursday 17 September 2026')
    expect(urgentExpiryDate(acceptBy)).toBe('2026-09-17')
  })

  it('follows the Sydney clock across daylight saving and a month end', () => {
    // AEDT, UTC+11: 13:30 UTC on 31 October is 12:30am on 1 November in Sydney.
    expect(urgentExpiryDate('2026-10-31T13:30:00.000Z')).toBe('2026-11-01')
    // AEST, UTC+10: 14:30 UTC on 31 December is 1:30am on 1 January.
    expect(urgentExpiryDate('2026-12-31T14:30:00.000Z')).toBe('2027-01-01')
  })

  it('is always the Sydney day after the quote, at every hour of the day', () => {
    // The property the customer is promised: whatever hour Jack quotes at, the
    // expiry HubSpot shows is the day the 24 hours run out in Sydney, and it is
    // never the same day as the quote.
    for (let hour = 0; hour < 24; hour += 1) {
      const raisedAt = new Date(Date.UTC(2026, 8, 16, hour, 10, 0))
      const acceptBy = acceptByFrom(raisedAt)
      expect(urgentExpiryDate(acceptBy)).toBe(formatSydneyDate(raisedAt, 1))
      expect(urgentExpiryDate(acceptBy)).not.toBe(formatSydneyDate(raisedAt, 0))
    }
  })

  it('throws rather than putting a wrong date on a customer document', () => {
    expect(() => urgentExpiryDate('soon')).toThrow(/real timestamp/)
    expect(() => urgentExpiryDate('')).toThrow(/real timestamp/)
  })
})

/** The Sydney yyyy-mm-dd `plusDays` after the Sydney day `when` falls on,
 *  computed independently of the helper under test. */
function formatSydneyDate(when: Date, plusDays: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when)
  const [y, m, d] = parts.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + plusDays))
  return shifted.toISOString().slice(0, 10)
}

describe('urgent pricing: the 24 hour window', () => {
  const now = new Date('2026-09-14T05:15:00.000Z')

  it('closes 24 hours after the quote', () => {
    expect(acceptByFrom(now)).toBe('2026-09-15T05:15:00.000Z')
  })

  it('lapses at the deadline, and never on a missing or junk deadline', () => {
    expect(hasLapsed('2026-09-14T05:14:59.000Z', now)).toBe(true)
    expect(hasLapsed('2026-09-14T05:15:00.000Z', now)).toBe(true)
    expect(hasLapsed('2026-09-14T05:15:01.000Z', now)).toBe(false)
    expect(hasLapsed(null, now)).toBe(false)
    expect(hasLapsed('soon', now)).toBe(false)
  })

  it('caps urgent at one per deal in the window', () => {
    expect(checkUrgentCap(0)).toBeNull()
    expect(checkUrgentCap(1)).toBe('URGENT_CAP')
    expect(checkUrgentCap(4)).toBe('URGENT_CAP')
  })

})

describe('urgent pricing: the words on the quote', () => {
  // 05:15 UTC on 15 September 2026 is 3:15pm in Sydney (AEST, UTC+10).
  const acceptBy = '2026-09-15T05:15:00.000Z'

  it('says the deadline in Sydney time, in words', () => {
    expect(formatSydneyDeadline(acceptBy)).toBe('3:15pm Tuesday 15 September 2026')
  })

  it('follows the Sydney clock across daylight saving', () => {
    // AEDT, UTC+11, from the first Sunday in October.
    expect(formatSydneyDeadline('2026-10-06T05:15:00.000Z')).toBe('4:15pm Tuesday 6 October 2026')
  })

  it('adds the deadline line to an urgent quote and nothing to a list one', () => {
    expect(quoteComments('list', null)).toBe(AGENT_QUOTE_COMMENTS.join('\n'))
    expect(quoteComments('list', acceptBy)).toBe(AGENT_QUOTE_COMMENTS.join('\n'))
    expect(quoteComments('urgent', acceptBy)).toBe(
      [
        'Prices in Australian dollars, excluding GST.',
        'Freight is quoted separately.',
        'Urgent order price, valid until 3:15pm Tuesday 15 September 2026 Sydney time. After that the standard price applies.',
      ].join('\n'),
    )
  })

  it('stays ASCII, because this text reaches a customer document', () => {
    expect(urgentCommentLine(acceptBy)).toMatch(/^[\x20-\x7e]+$/)
    expect(quoteComments('urgent', acceptBy)).toMatch(/^[\x20-\x7e\n]+$/)
  })

  it('refuses to print a deadline it cannot read', () => {
    expect(() => formatSydneyDeadline('tomorrow')).toThrow(/real timestamp/)
  })
})

describe('reissue', () => {
  const good: DealShape = {
    pipeline: '14520121',
    dealstage: ANZ_QUOTATION_SENT_STAGE,
    hubspot_owner_id: '30234944',
    deal_currency_code: 'AUD',
    contactIds: ['247940140576'],
  }

  it('is allowed from Quotation sent and nowhere else', () => {
    expect(checkDealShape(good, [ANZ_QUOTATION_SENT_STAGE])).toBeNull()
    for (const dealstage of ['39459178', '39459179', '39459180', '39459181']) {
      expect(checkDealShape({ ...good, dealstage }, [ANZ_QUOTATION_SENT_STAGE])).toBe('BAD_STAGE')
      // The same deal is quotable on a create, so this really is the narrowing.
      expect(checkDealShape({ ...good, dealstage })).toBeNull()
    }
    expect(checkDealShape({ ...good, dealstage: '39459183' }, [ANZ_QUOTATION_SENT_STAGE])).toBe('DEAL_CLOSED')
  })

  it('rebuilds the request lines from a stored deal_quotes row', () => {
    expect(
      linesFromRow([
        { productId: H10, quantity: 4, name: 'H10' } as unknown as { productId: string; quantity: number },
        { productId: HOOKS, quantity: 4 },
        { productId: HOOKS, quantity: 4 },
      ]),
    ).toEqual([
      { productId: H10, quantity: 4 },
      { productId: HOOKS, quantity: 8 },
    ])
  })

  it('drops rows it cannot read rather than guessing a quantity', () => {
    expect(linesFromRow([{ productId: '', quantity: 4 }, { productId: H9, quantity: 0 }, { productId: H9 }])).toEqual([])
    expect(linesFromRow(null)).toEqual([])
    expect(linesFromRow(undefined)).toEqual([])
  })
})
