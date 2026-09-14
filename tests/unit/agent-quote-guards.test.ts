import { describe, it, expect } from 'vitest'
import {
  authorizeBearer,
  parseAgentQuoteBody,
  checkProductsAllowed,
  checkProductSkus,
  checkDealShape,
  checkListPriced,
  amountCeiling,
  checkAmountCeiling,
  checkCaps,
  linesKey,
  mergeLines,
  isUuid,
  hasAmountMismatch,
  quoteReferenceOf,
  CODE_STATUS,
  AGENT_QUOTE_COMMENTS,
  type DealShape,
} from '@/lib/agent-quote/guards'

/**
 * Guards for POST /api/agent/quote. Contract C1 in the Bruce quotes plan.
 * Every refusal here happens before a single HubSpot write.
 */

const H9 = '1640186928'
const H10 = '29231439287'
const H8 = '29207461216'
const H9X = '19850990926'
const HOOKS = '29207708995'
const BUNGEES = '29231439368'

const base = { action: 'create', conversationId: 'conv_abc123', dealId: '64951402250' }

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

  it('flags an amount mismatch only above a cent', () => {
    expect(hasAmountMismatch(100, 100.01)).toBe(false)
    expect(hasAmountMismatch('100', '100.02')).toBe(true)
    expect(hasAmountMismatch(null, 100)).toBe(false)
  })
})

describe('caps, ids and fixed values', () => {
  it('caps at 3 per deal per 7 days and 20 per day', () => {
    expect(checkCaps({ dealLast7Days: 2, allLast24Hours: 19 })).toBeNull()
    expect(checkCaps({ dealLast7Days: 3, allLast24Hours: 0 })).toBe('CAP_REACHED')
    expect(checkCaps({ dealLast7Days: 0, allLast24Hours: 20 })).toBe('CAP_REACHED')
  })

  it('accepts only a uuid for BRUCE_USER_ID', () => {
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
    expect(CODE_STATUS.CAP_REACHED).toBe(409)
    for (const c of ['NOT_ANZ_DEAL', 'DEAL_CLOSED', 'BAD_STAGE', 'WRONG_OWNER', 'NOT_AUD', 'CONTACT_COUNT', 'CONTRACT_CUSTOMER', 'FOREIGN_QUOTE', 'PRODUCT_NOT_ALLOWED', 'NO_PRICE', 'AMOUNT_CEILING', 'TEMPLATE_MISSING', 'NO_BRUCE_QUOTE'] as const) {
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
