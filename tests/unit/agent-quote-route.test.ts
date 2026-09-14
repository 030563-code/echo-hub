import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { urgentCommentLine, urgentExpiryDate, formatSydneyDeadline, AGENT_QUOTE_COMMENTS } from '@/lib/agent-quote/guards'

/**
 * POST /api/agent/quote, the whole route with its collaborators mocked.
 *
 * The live stage-1 check can only reach NOT_BOUND while no log_lead row binds a
 * conversation to the fixture deal, so this is where the downstream path is
 * proven: the order of refusals, that nothing writes before the last guard,
 * the urgent floor pricing and its reissue, that a retry can only ever finish
 * THIS request's row, that the real agent seam hands the Jack client to every
 * createServerClient call, and that the session is always signed out.
 */

const SECRET = 'f'.repeat(64)
const JACK_ID = '11111111-2222-4333-8444-555555555555'
const DEAL = '64951402250'
const CONV = 'conv_7001abc'
const H9 = '1640186928'
const HOOKS = '29207708995'

// --- next/headers: the agent path must never read cookies --------------------
const cookies = vi.fn(async () => {
  throw new Error('cookies() must not be called on the agent path')
})
vi.mock('next/headers', () => ({ cookies: () => cookies() }))

// --- the Jack session --------------------------------------------------------
const signOut = vi.fn(async () => {})
const jackGetUser = vi.fn(async () => ({ data: { user: { id: JACK_ID } }, error: null }))
const jackClient = { auth: { getUser: jackGetUser } }
const mintJackClient = vi.fn(async () => ({ client: jackClient, userId: JACK_ID, signOut }))
vi.mock('@/lib/agent-quote/session', () => ({ mintJackClient: () => mintJackClient() }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))

// --- data reads --------------------------------------------------------------
const data = {
  isConversationBound: vi.fn(),
  countJackQuotes: vi.fn(),
  countUrgentQuotes: vi.fn(),
  findRepeatQuote: vi.fn(),
  findLatestJackQuote: vi.fn(),
  findResumableQuote: vi.fn(),
  hasForeignQuote: vi.fn(),
  hasInFlightQuote: vi.fn(),
  hasPublishedJackQuote: vi.fn(),
  hasActiveContractPrices: vi.fn(),
  readHubSpotProducts: vi.fn(),
}
vi.mock('@/lib/agent-quote/data', () => ({
  isConversationBound: (...a: unknown[]) => data.isConversationBound(...a),
  countJackQuotes: (...a: unknown[]) => data.countJackQuotes(...a),
  countUrgentQuotes: (...a: unknown[]) => data.countUrgentQuotes(...a),
  findRepeatQuote: (...a: unknown[]) => data.findRepeatQuote(...a),
  findLatestJackQuote: (...a: unknown[]) => data.findLatestJackQuote(...a),
  findResumableQuote: (...a: unknown[]) => data.findResumableQuote(...a),
  hasForeignQuote: (...a: unknown[]) => data.hasForeignQuote(...a),
  hasInFlightQuote: (...a: unknown[]) => data.hasInFlightQuote(...a),
  hasPublishedJackQuote: (...a: unknown[]) => data.hasPublishedJackQuote(...a),
  hasActiveContractPrices: (...a: unknown[]) => data.hasActiveContractPrices(...a),
  readHubSpotProducts: (...a: unknown[]) => data.readHubSpotProducts(...a),
}))

// --- the unchanged Hub actions ---------------------------------------------
const seenClients: unknown[] = []
const getDealDetails = vi.fn()
const loadPricingForQuote = vi.fn()
const createQuote = vi.fn()
const retryHubSpotQuote = vi.fn()
const markQuoteSent = vi.fn()

async function recordClient() {
  const { createServerClient } = await import('@/lib/supabase/server')
  seenClients.push(await createServerClient())
}

vi.mock('@/app/actions/hubspot/getDealDetails', () => ({
  getDealDetails: async (...a: unknown[]) => {
    await recordClient()
    return getDealDetails(...a)
  },
}))
vi.mock('@/app/actions/pricing/get-pricing', () => ({ loadPricingForQuote: (...a: unknown[]) => loadPricingForQuote(...a) }))
vi.mock('@/app/actions/sales/create-quote', () => ({
  createQuote: async (...a: unknown[]) => {
    await recordClient()
    return createQuote(...a)
  },
}))
vi.mock('@/app/actions/sales/publish-quote', () => ({ retryHubSpotQuote: (...a: unknown[]) => retryHubSpotQuote(...a) }))
vi.mock('@/app/actions/sales/mark-quote-sent', () => ({ markQuoteSent: (...a: unknown[]) => markQuoteSent(...a) }))

let templateId: string | null = null
vi.mock('@/lib/pipeline-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pipeline-config')>()
  return { ...real, quoteTemplateIdFor: (v: string) => (String(v).toUpperCase() === 'AU' ? templateId : real.quoteTemplateIdFor(v)) }
})

import { POST } from '@/app/api/agent/quote/route'

// --- fixtures ------------------------------------------------------------------
const fixtureDeal = {
  success: true,
  data: {
    id: DEAL,
    properties: { pipeline: '14520121', dealstage: '39459179', hubspot_owner_id: '30234944', deal_currency_code: 'AUD', dealname: 'Fixture' },
    associations: { contacts: { results: [{ id: '247940140576' }, { id: '247940140576' }] } },
  },
}
const quotationSentDeal = {
  ...fixtureDeal,
  data: { ...fixtureDeal.data, properties: { ...fixtureDeal.data.properties, dealstage: '39459182' } },
}
const products = {
  [H9]: { sku: 'EBH9NA', name: 'Echo Barrier H9' },
  [HOOKS]: { sku: 'HKNA', name: 'Echo Barrier Metal Hooks (Part of Fitting Kit)' },
}
const audRows = [
  { sku: 'EBH9NA', currency: 'AUD', unit_price: 250, floor_price: 200, is_active: true },
  { sku: 'HKNA', currency: 'AUD', unit_price: 5, floor_price: 4, is_active: true },
]
/** Jack's rep_discount_caps row: no percentage limit, the floor is the guard. */
const jackCap = { max_discount_pct: null, max_discount_per_unit: 2700 }
const publishedQuote = {
  dealQuoteId: '9b2f0c1e-0000-4000-8000-000000000001',
  quoteId: '123',
  quoteNumber: 'JA202600123',
  quoteLink: 'https://info.echobarrier.com/q/abc',
  pdfLink: 'https://info.echobarrier.com/q/abc.pdf',
  amount: 10200,
  hubAmount: 10200,
  amountMismatch: false,
  expiresOn: '2026-10-14',
  linkChanged: false,
}

function req(body: unknown, auth: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth !== null) headers.authorization = auth
  return new Request('http://localhost/api/agent/quote', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
const create = (lines = [{ productId: H9, quantity: 40 }, { productId: HOOKS, quantity: 40 }]) => ({
  action: 'create',
  conversationId: CONV,
  dealId: DEAL,
  lines,
  pricing: 'list',
})
const urgent = (lines = [{ productId: H9, quantity: 40 }, { productId: HOOKS, quantity: 40 }]) => ({
  ...create(lines),
  pricing: 'urgent',
  urgencyNote: 'site starts Monday',
})
const markSent = { action: 'mark_sent', conversationId: CONV, dealId: DEAL }
const reissue = { action: 'reissue', dealId: DEAL }

async function call(r: Request) {
  const res = await POST(r)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** Everything the create path needs to reach createQuote. */
function readyToQuote(cap: typeof jackCap | null = jackCap) {
  templateId = '999000111'
  loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap })
}

beforeEach(() => {
  vi.clearAllMocks()
  seenClients.length = 0
  templateId = null
  process.env.AGENT_QUOTE_SECRET = SECRET
  delete process.env.AGENT_QUOTE_SECRET_PREVIOUS
  process.env.JACK_USER_ID = JACK_ID
  delete process.env.AGENT_QUOTE_AMOUNT_CEILING
  data.isConversationBound.mockResolvedValue(true)
  data.countJackQuotes.mockResolvedValue({ dealLast7Days: 0, allLast24Hours: 0 })
  data.countUrgentQuotes.mockResolvedValue(0)
  data.findRepeatQuote.mockResolvedValue(null)
  data.findLatestJackQuote.mockResolvedValue(null)
  data.findResumableQuote.mockResolvedValue(null)
  data.hasForeignQuote.mockResolvedValue(false)
  data.hasInFlightQuote.mockResolvedValue(false)
  data.hasPublishedJackQuote.mockResolvedValue(true)
  data.hasActiveContractPrices.mockResolvedValue(false)
  data.readHubSpotProducts.mockResolvedValue(products)
  getDealDetails.mockResolvedValue(fixtureDeal)
  loadPricingForQuote.mockResolvedValue({ listPrices: [], contractPrices: [], contractorName: null, cap: null })
  createQuote.mockResolvedValue({ success: true, quoteReference: 'JA202600123', quote: publishedQuote })
  retryHubSpotQuote.mockResolvedValue({ success: false, error: 'x' })
  markQuoteSent.mockResolvedValue({ success: true })
})

function expectNoWrites() {
  expect(createQuote).not.toHaveBeenCalled()
  expect(retryHubSpotQuote).not.toHaveBeenCalled()
  expect(markQuoteSent).not.toHaveBeenCalled()
}

describe('auth and body', () => {
  it('401 without a header, with a wrong secret, and always when the secret is unset', async () => {
    expect(await call(req(create(), null))).toEqual({ status: 401, body: { ok: false, code: 'UNAUTHORIZED' } })
    expect((await call(req(create(), 'Bearer nope'))).status).toBe(401)
    delete process.env.AGENT_QUOTE_SECRET
    expect((await call(req(create(), 'Bearer '))).status).toBe(401)
    expect((await call(req(create(), `Bearer ${SECRET}`))).status).toBe(401)
    expect(data.isConversationBound).not.toHaveBeenCalled()
  })

  it('400 for broken JSON, extra keys, limits and a missing pricing mode, without echoing input', async () => {
    expect(await call(req('{not json'))).toEqual({ status: 400, body: { ok: false, code: 'BAD_REQUEST' } })
    expect((await call(req({ ...create(), comments: 'x' }))).body).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect((await call(req(create([{ productId: H9, quantity: 201 }])))).status).toBe(400)
    const noPricing: Record<string, unknown> = { ...create() }
    delete noPricing.pricing
    expect((await call(req(noPricing))).status).toBe(400)
    expect(data.isConversationBound).not.toHaveBeenCalled()
  })

  it('500 when JACK_USER_ID is not a uuid', async () => {
    process.env.JACK_USER_ID = 'jack'
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
  })
})

describe('before the session', () => {
  it('403 NOT_BOUND when no log_lead row binds the conversation to the deal', async () => {
    data.isConversationBound.mockResolvedValue(false)
    expect(await call(req(create()))).toEqual({ status: 403, body: { ok: false, code: 'NOT_BOUND' } })
    expect(data.isConversationBound).toHaveBeenCalledWith({ tag: 'admin' }, CONV, DEAL, expect.any(Date))
    expect(mintJackClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('422 PRODUCT_NOT_ALLOWED for a product off the ANZ list', async () => {
    expect(await call(req(create([{ productId: '999', quantity: 1 }])))).toEqual({ status: 422, body: { ok: false, code: 'PRODUCT_NOT_ALLOWED' } })
    expect(mintJackClient).not.toHaveBeenCalled()
  })

  it('200 REPEAT returns the earlier published quote without a session', async () => {
    data.findRepeatQuote.mockResolvedValue({
      id: publishedQuote.dealQuoteId, quote_number: 'JA202600123-2', quote_link: publishedQuote.quoteLink, pdf_link: null,
      amount: '10200.00', hub_amount: '10200', currency: 'AUD', expires_on: '2026-10-14', pricing_mode: 'list', accept_by: null, line_items: [],
    })
    const { status, body } = await call(req(create()))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true, code: 'REPEAT', quoteReference: 'JA202600123', quoteNumber: 'JA202600123-2', quoteLink: publishedQuote.quoteLink,
      pdfLink: null, amount: 10200, currency: 'AUD', expiresOn: '2026-10-14', dealQuoteId: publishedQuote.dealQuoteId,
      amountMismatch: false, pricing: 'list', acceptBy: null,
    })
    expect(mintJackClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('refuses rather than quoting again when the earlier quote published with no link', async () => {
    // There IS a live HubSpot quote under that number; a second one for the
    // same cart would be numbered REF-2 and both would be public.
    data.findRepeatQuote.mockResolvedValue({
      id: publishedQuote.dealQuoteId, quote_number: 'JA202600123', quote_link: null, pdf_link: null,
      amount: 10200, hub_amount: 10200, currency: 'AUD', expires_on: '2026-10-14', pricing_mode: 'list', accept_by: null, line_items: [],
    })
    expect(await call(req(create()))).toEqual({ status: 502, body: { ok: false, code: 'QUOTE_PUBLISH_FAILED' } })
    expect(mintJackClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('asks for a repeat of the SAME pricing, so an urgent call never gets a list link', async () => {
    await call(req(urgent()))
    expect(data.findRepeatQuote).toHaveBeenCalledWith({ tag: 'admin' }, JACK_ID, DEAL, expect.any(Array), 'urgent', expect.any(Date))
    await call(req(create()))
    expect(data.findRepeatQuote).toHaveBeenLastCalledWith({ tag: 'admin' }, JACK_ID, DEAL, expect.any(Array), 'list', expect.any(Date))
  })

  it('falls back to hub_amount when a repeat row has no HubSpot amount', async () => {
    data.findRepeatQuote.mockResolvedValue({
      id: publishedQuote.dealQuoteId, quote_number: 'JA202600123', quote_link: publishedQuote.quoteLink, pdf_link: null,
      amount: null, hub_amount: '8160.00', currency: 'AUD', expires_on: '2026-09-15', pricing_mode: 'urgent',
      accept_by: '2026-09-15T05:15:00.000Z', line_items: [],
    })
    expect((await call(req(urgent()))).body).toMatchObject({
      code: 'REPEAT', amount: 8160, pricing: 'urgent', acceptBy: '2026-09-15T05:15:00.000Z',
    })
  })

  it('409 CAP_REACHED at 3 on the deal or 20 in the day', async () => {
    data.countJackQuotes.mockResolvedValue({ dealLast7Days: 3, allLast24Hours: 3 })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'CAP_REACHED' })
    data.countJackQuotes.mockResolvedValue({ dealLast7Days: 0, allLast24Hours: 20 })
    expect((await call(req(create()))).status).toBe(409)
    expect(mintJackClient).not.toHaveBeenCalled()
  })

  it('422 FOREIGN_QUOTE when a person already quoted the deal, BEFORE the repeat link goes out', async () => {
    data.hasForeignQuote.mockResolvedValue(true)
    data.findRepeatQuote.mockResolvedValue({
      id: publishedQuote.dealQuoteId, quote_number: 'JA202600123', quote_link: publishedQuote.quoteLink, pdf_link: null,
      amount: 10200, hub_amount: 10200, currency: 'AUD', expires_on: '2026-10-14', pricing_mode: 'list', accept_by: null, line_items: [],
    })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'FOREIGN_QUOTE' })
    expect(data.findRepeatQuote).not.toHaveBeenCalled()
    expect(mintJackClient).not.toHaveBeenCalled()
  })

  it('409 IN_PROGRESS while another generate or an edit owns the deal', async () => {
    data.hasInFlightQuote.mockResolvedValue(true)
    expect(await call(req(create()))).toEqual({ status: 409, body: { ok: false, code: 'IN_PROGRESS' } })
    expect(data.hasInFlightQuote).toHaveBeenCalledWith({ tag: 'admin' }, DEAL)
    expect(mintJackClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('500 INTERNAL when a Supabase read fails, never a silent pass', async () => {
    data.isConversationBound.mockRejectedValue(new Error('boom'))
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
  })
})

describe('inside the Jack session', () => {
  it('hands the Jack client to every createServerClient call and never reads cookies', async () => {
    readyToQuote()
    await call(req(create()))
    expect(seenClients.length).toBeGreaterThanOrEqual(2)
    for (const c of seenClients) expect(c).toBe(jackClient)
    expect(cookies).not.toHaveBeenCalled()
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('NO_PRICE while no AUD list rows exist (today), with no write and a signed-out session', async () => {
    expect(await call(req(create()))).toEqual({ status: 422, body: { ok: false, code: 'NO_PRICE' } })
    expect(loadPricingForQuote).toHaveBeenCalledWith({ companyId: 'UNKNOWN', currency: 'AUD', userId: JACK_ID })
    expectNoWrites()
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('TEMPLATE_MISSING once prices exist but the AU template id is still null', async () => {
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
    expect(await call(req(create()))).toEqual({ status: 422, body: { ok: false, code: 'TEMPLATE_MISSING' } })
    expectNoWrites()
  })

  it('refuses a deal of the wrong shape', async () => {
    getDealDetails.mockResolvedValue({ ...fixtureDeal, data: { ...fixtureDeal.data, properties: { ...fixtureDeal.data.properties, deal_currency_code: 'USD' } } })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'NOT_AUD' })
    getDealDetails.mockResolvedValue({ ...fixtureDeal, data: { ...fixtureDeal.data, associations: { contacts: { results: [{ id: '1' }, { id: '2' }] } } } })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'CONTACT_COUNT' })
    getDealDetails.mockResolvedValue({ success: false, error: 'Deal not found' })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'NOT_ANZ_DEAL' })
    getDealDetails.mockResolvedValue({ success: false, error: 'Failed to fetch deal details' })
    expect((await call(req(create()))).status).toBe(502)
    expectNoWrites()
  })

  it('CONTRACT_CUSTOMER when an associated company has active contract prices', async () => {
    getDealDetails.mockResolvedValue({ ...fixtureDeal, data: { ...fixtureDeal.data, associations: { ...fixtureDeal.data.associations, companies: { results: [{ id: '58377910351' }] } } } })
    data.hasActiveContractPrices.mockResolvedValue(true)
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'CONTRACT_CUSTOMER' })
    expect(data.hasActiveContractPrices).toHaveBeenCalledWith({ tag: 'admin' }, ['58377910351'])
    expectNoWrites()
  })

  it('PRODUCT_NOT_ALLOWED when HubSpot holds a different SKU', async () => {
    data.readHubSpotProducts.mockResolvedValue({ ...products, [H9]: { sku: 'EBH9', name: 'x' } })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'PRODUCT_NOT_ALLOWED' })
  })

  it('AMOUNT_CEILING above the configured ceiling', async () => {
    readyToQuote()
    process.env.AGENT_QUOTE_AMOUNT_CEILING = '5000'
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'AMOUNT_CEILING' })
    expectNoWrites()
  })

  it('CREATED calls the unchanged createQuote with fixed server-side values and list prices', async () => {
    readyToQuote()
    const { status, body } = await call(req(create()))
    expect(status).toBe(200)
    expect(createQuote).toHaveBeenCalledTimes(1)
    expect(createQuote).toHaveBeenCalledWith({
      dealId: DEAL,
      distributor: 'Direct Sale',
      depot: 'AU-SYD',
      template: 'AU',
      lineItems: [
        { productId: H9, name: 'Echo Barrier H9', quantity: 40, unitPrice: 250, total: 10000, sku: 'EBH9NA' },
        { productId: HOOKS, name: 'Echo Barrier Metal Hooks (Part of Fitting Kit)', quantity: 40, unitPrice: 5, total: 200, sku: 'HKNA' },
      ],
      totalAmount: 10200,
      comments: 'Prices in Australian dollars, excluding GST.\nFreight is quoted separately.',
      isCollection: false,
      isPreview: false,
      agentQuote: { pricingMode: 'list', acceptBy: null, reissueOf: null, urgencyNote: null },
    })
    // No expiryDate key at all on a list quote: the house 60 days stands.
    expect(Object.keys(createQuote.mock.calls[0][0])).not.toContain('expiryDate')
    expect(body).toEqual({
      ok: true, code: 'CREATED', quoteReference: 'JA202600123', quoteNumber: 'JA202600123', quoteLink: publishedQuote.quoteLink,
      pdfLink: publishedQuote.pdfLink, amount: 10200, currency: 'AUD', expiresOn: '2026-10-14', dealQuoteId: publishedQuote.dealQuoteId,
      amountMismatch: false, pricing: 'list', acceptBy: null,
    })
    expect(retryHubSpotQuote).not.toHaveBeenCalled()
  })

  it('HUBSPOT_ERROR when createQuote refuses (the staging kill switch lands here)', async () => {
    readyToQuote()
    createQuote.mockResolvedValue({ success: false, error: 'Sandbox (staging): the live hand-off was skipped' })
    expect(await call(req(create()))).toEqual({ status: 502, body: { ok: false, code: 'HUBSPOT_ERROR' } })
  })

  it('INTERNAL and a sign-out when the session user is not Jack', async () => {
    jackGetUser.mockResolvedValueOnce({ data: { user: { id: 'someone-else' } }, error: null })
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(getDealDetails).not.toHaveBeenCalled()
  })

  it('INTERNAL when the session cannot be minted', async () => {
    mintJackClient.mockRejectedValueOnce(new Error('verify'))
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
    expectNoWrites()
  })

  it('signs out even when an action throws', async () => {
    getDealDetails.mockRejectedValueOnce(new Error('network'))
    expect((await call(req(create()))).status).toBe(500)
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})

describe('urgent pricing', () => {
  it('quotes each line down to its floor as a cash discount, expiring tomorrow', async () => {
    readyToQuote()
    createQuote.mockResolvedValue({
      success: true,
      quoteReference: 'JA202600123',
      quote: { ...publishedQuote, amount: 8160, hubAmount: 8160, expiresOn: '2026-09-15' },
    })
    const { status, body } = await call(req(urgent()))
    expect(status).toBe(200)

    const sent = createQuote.mock.calls[0][0]
    // 250 -> 200 and 5 -> 4, sent as money off the UNIT price, so the net is
    // the floor and createQuote re-derives it from its own list rows.
    expect(sent.lineItems).toEqual([
      { productId: H9, name: 'Echo Barrier H9', quantity: 40, unitPrice: 250, total: 8000, sku: 'EBH9NA', discountMode: 'amount', discountValue: 50 },
      { productId: HOOKS, name: 'Echo Barrier Metal Hooks (Part of Fitting Kit)', quantity: 40, unitPrice: 5, total: 160, sku: 'HKNA', discountMode: 'amount', discountValue: 1 },
    ])
    expect(sent.totalAmount).toBe(8160)
    expect(sent.expiryDate).toBe(urgentExpiryDate(String(body.acceptBy)))
    expect(sent.agentQuote).toEqual({
      pricingMode: 'urgent',
      acceptBy: body.acceptBy,
      reissueOf: null,
      urgencyNote: 'site starts Monday',
    })
    expect(body).toMatchObject({ code: 'CREATED', pricing: 'urgent', amount: 8160 })
  })

  it('prints the acceptance deadline on the quote, matching the acceptBy it answers with', async () => {
    readyToQuote()
    const { body } = await call(req(urgent()))
    const acceptBy = String(body.acceptBy)
    expect(Date.parse(acceptBy)).toBeGreaterThan(Date.now())
    expect(Date.parse(acceptBy) - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    expect(createQuote.mock.calls[0][0].comments).toBe([...AGENT_QUOTE_COMMENTS, urgentCommentLine(acceptBy)].join('\n'))
    // The urgency note is the audit, never the document.
    expect(createQuote.mock.calls[0][0].comments).not.toContain('site starts Monday')
  })

  describe('the expiry HubSpot shows agrees with the deadline printed on the quote', () => {
    // Only Date is faked. The route's collaborators are all mocked and resolve
    // without a timer, so faking the clock alone keeps the run honest.
    afterEach(() => {
      vi.useRealTimers()
    })

    /** Raise an urgent quote at a fixed instant and read back the three things
     *  that have to name the same Sydney day. */
    async function urgentAt(raisedAt: string) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(raisedAt))
      readyToQuote()
      const { status, body } = await call(req(urgent()))
      expect(status).toBe(200)
      const acceptBy = String(body.acceptBy)
      const sent = createQuote.mock.calls[0][0]
      return {
        acceptBy,
        expiryDate: sent.expiryDate as string,
        deadlineWords: formatSydneyDeadline(acceptBy),
        // What the UTC day count used to produce: today in UTC, plus one day.
        utcDatePlusOne: new Date(Date.parse(raisedAt) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      }
    }

    it('before 10am Sydney, where the UTC date is still yesterday there', async () => {
      // 23:10 UTC on Tuesday 15 September is 9:10am Wednesday 16 in Sydney, so
      // the price holds until 9:10am Thursday 17. The old day count read the
      // UTC date (the 15th), added a day and expired the quote on the 16th, a
      // full calendar day before the deadline printed on that same quote and
      // in the email, including the whole of Geoff's Thursday morning.
      const { expiryDate, deadlineWords, utcDatePlusOne } = await urgentAt('2026-09-15T23:10:00.000Z')
      expect(deadlineWords).toBe('9:10am Thursday 17 September 2026')
      expect(expiryDate).toBe('2026-09-17')
      expect(utcDatePlusOne).toBe('2026-09-16')
      expect(expiryDate).not.toBe(utcDatePlusOne)
    })

    it('after 10am Sydney, where the two agreed already', async () => {
      // 04:00 UTC on Wednesday 16 September is 2pm that afternoon in Sydney.
      const { expiryDate, deadlineWords, utcDatePlusOne } = await urgentAt('2026-09-16T04:00:00.000Z')
      expect(deadlineWords).toBe('2:00pm Thursday 17 September 2026')
      expect(expiryDate).toBe('2026-09-17')
      expect(expiryDate).toBe(utcDatePlusOne)
    })

    it('at midnight Sydney, the far side of the same boundary', async () => {
      // 14:00 UTC on 15 September is midnight on the 16th in Sydney (AEST).
      const { expiryDate, deadlineWords } = await urgentAt('2026-09-15T14:00:00.000Z')
      expect(deadlineWords).toBe('12:00am Thursday 17 September 2026')
      expect(expiryDate).toBe('2026-09-17')
    })

    it('holds across daylight saving, when Sydney runs eleven hours ahead', async () => {
      // 22:10 UTC on 5 November is 9:10am on the 6th in Sydney (AEDT, UTC+11).
      const { expiryDate, deadlineWords } = await urgentAt('2026-11-05T22:10:00.000Z')
      expect(deadlineWords).toBe('9:10am Saturday 7 November 2026')
      expect(expiryDate).toBe('2026-11-07')
    })
  })

  it('NO_FLOOR rather than a guessed price when a line has no floor', async () => {
    readyToQuote()
    loadPricingForQuote.mockResolvedValue({
      listPrices: [audRows[0], { ...audRows[1], floor_price: null }],
      contractPrices: [], contractorName: null, cap: jackCap,
    })
    expect(await call(req(urgent()))).toEqual({ status: 422, body: { ok: false, code: 'NO_FLOOR' } })
    expectNoWrites()
  })

  it('DISCOUNT_REFUSED when Jack has no discount cap row at all', async () => {
    readyToQuote(null)
    expect(await call(req(urgent()))).toEqual({ status: 422, body: { ok: false, code: 'DISCOUNT_REFUSED' } })
    expectNoWrites()
    // The same cart at list pricing still goes out: only the floor needs a cap.
    expect((await call(req(create()))).status).toBe(200)
  })

  it('DISCOUNT_REFUSED when the per-unit cap is below the floor gap', async () => {
    readyToQuote({ max_discount_pct: null, max_discount_per_unit: 10 })
    expect((await call(req(urgent()))).body).toEqual({ ok: false, code: 'DISCOUNT_REFUSED' })
    expectNoWrites()
  })

  it('URGENT_CAP at one urgent quote per deal per 30 days, and never on a list quote', async () => {
    readyToQuote()
    data.countUrgentQuotes.mockResolvedValue(1)
    expect(await call(req(urgent()))).toEqual({ status: 409, body: { ok: false, code: 'URGENT_CAP' } })
    expect(mintJackClient).not.toHaveBeenCalled()
    expect((await call(req(create()))).status).toBe(200)
    expect(data.countUrgentQuotes).toHaveBeenCalledTimes(1)
  })
})

describe('reissue', () => {
  const lapsedUrgent = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'published',
    pricing_mode: 'urgent',
    accept_by: '2020-01-01T00:00:00.000Z',
    reissue_of: null,
    quote_number: 'JA202600123',
    quote_link: 'https://info.echobarrier.com/q/old',
    pdf_link: null,
    amount: 8160,
    hub_amount: 8160,
    currency: 'AUD',
    expires_on: '2026-09-15',
    created_at: '2026-09-13T00:00:00.000Z',
    line_items: [{ productId: H9, quantity: 40 }, { productId: HOOKS, quantity: 40 }],
  }

  beforeEach(() => {
    data.findLatestJackQuote.mockResolvedValue(lapsedUrgent)
    // A deal holding a lapsed urgent quote sits on Quotation sent.
    getDealDetails.mockResolvedValue(quotationSentDeal)
  })

  it('needs no conversation binding and requotes the same lines at list prices', async () => {
    readyToQuote()
    const { status, body } = await call(req(reissue))
    expect(status).toBe(200)
    expect(data.isConversationBound).not.toHaveBeenCalled()
    const sent = createQuote.mock.calls[0][0]
    expect(sent.lineItems).toEqual([
      { productId: H9, name: 'Echo Barrier H9', quantity: 40, unitPrice: 250, total: 10000, sku: 'EBH9NA' },
      { productId: HOOKS, name: 'Echo Barrier Metal Hooks (Part of Fitting Kit)', quantity: 40, unitPrice: 5, total: 200, sku: 'HKNA' },
    ])
    expect(sent.totalAmount).toBe(10200)
    expect(sent.comments).toBe(AGENT_QUOTE_COMMENTS.join('\n'))
    expect(Object.keys(sent)).not.toContain('expiryDate')
    expect(sent.agentQuote).toEqual({ pricingMode: 'list', acceptBy: null, reissueOf: lapsedUrgent.id, urgencyNote: null })
    expect(body).toMatchObject({ code: 'REISSUED', pricing: 'list', acceptBy: null, quoteLink: publishedQuote.quoteLink })
  })

  it('is refused from any stage but Quotation sent', async () => {
    readyToQuote()
    getDealDetails.mockResolvedValue(fixtureDeal) // 39459179
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'BAD_STAGE' })
    getDealDetails.mockResolvedValue(quotationSentDeal)
    expect((await call(req(reissue))).status).toBe(200)
  })

  it('NO_URGENT_QUOTE with no Jack quote, a list one, or one that never published', async () => {
    data.findLatestJackQuote.mockResolvedValue(null)
    expect(await call(req(reissue))).toEqual({ status: 422, body: { ok: false, code: 'NO_URGENT_QUOTE' } })
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, pricing_mode: 'list', accept_by: null })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'NO_URGENT_QUOTE' })
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, status: 'failed' })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'NO_URGENT_QUOTE' })
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, quote_link: null })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'NO_URGENT_QUOTE' })
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, line_items: [] })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'NO_URGENT_QUOTE' })
    expectNoWrites()
    expect(mintJackClient).not.toHaveBeenCalled()
  })

  it('NOT_LAPSED while the 24 hours are still running', async () => {
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, accept_by: new Date(Date.now() + 3600_000).toISOString() })
    expect(await call(req(reissue))).toEqual({ status: 422, body: { ok: false, code: 'NOT_LAPSED' } })
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, accept_by: null })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'NOT_LAPSED' })
    expectNoWrites()
  })

  it('answers a second reissue with the SAME quote rather than minting another', async () => {
    const reissued = {
      ...lapsedUrgent,
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      pricing_mode: 'list',
      accept_by: null,
      reissue_of: lapsedUrgent.id,
      quote_number: 'JA202600123-2',
      quote_link: 'https://info.echobarrier.com/q/new',
      amount: 10200,
      hub_amount: 10200,
      expires_on: '2026-11-13',
    }
    data.findLatestJackQuote.mockResolvedValue(reissued)
    expect(await call(req(reissue))).toEqual({
      status: 200,
      body: {
        ok: true, code: 'REISSUED', quoteReference: 'JA202600123', quoteNumber: 'JA202600123-2',
        quoteLink: reissued.quote_link, pdfLink: null, amount: 10200, currency: 'AUD', expiresOn: '2026-11-13',
        dealQuoteId: reissued.id, amountMismatch: false, pricing: 'list', acceptBy: null,
      },
    })
    expectNoWrites()
  })

  it('REISSUE_CAP when the reissue exists but never published', async () => {
    data.findLatestJackQuote.mockResolvedValue({ ...lapsedUrgent, id: 'bbbbbbbb-0000-4000-8000-000000000002', reissue_of: lapsedUrgent.id, status: 'failed' })
    expect(await call(req(reissue))).toEqual({ status: 409, body: { ok: false, code: 'REISSUE_CAP' } })
    expectNoWrites()
  })

  it('still refuses a foreign quote, an in-flight row and the volume caps', async () => {
    readyToQuote()
    data.hasForeignQuote.mockResolvedValue(true)
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'FOREIGN_QUOTE' })
    data.hasForeignQuote.mockResolvedValue(false)
    data.hasInFlightQuote.mockResolvedValue(true)
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'IN_PROGRESS' })
    data.hasInFlightQuote.mockResolvedValue(false)
    data.countJackQuotes.mockResolvedValue({ dealLast7Days: 3, allLast24Hours: 0 })
    expect((await call(req(reissue))).body).toEqual({ ok: false, code: 'CAP_REACHED' })
    expectNoWrites()
  })
})

describe('a publish that did not come back', () => {
  /** A row this request wrote: Jack's, just now, with these lines. */
  const ourRow = () => ({
    id: publishedQuote.dealQuoteId,
    created_by_uid: JACK_ID,
    created_at: new Date(Date.now() + 10).toISOString(),
    status: 'draft',
    line_items: [{ productId: H9, quantity: 40 }, { productId: HOOKS, quantity: 40 }],
  })

  beforeEach(() => {
    readyToQuote()
    createQuote.mockResolvedValue({ success: true, quoteReference: 'JA202600123', quoteError: 'publish failed' })
  })

  it('IN_PROGRESS on the in-flight collision, with NO retry at all', async () => {
    createQuote.mockResolvedValue({
      success: true,
      quoteReference: 'JA202600123',
      quoteError: 'A quote is already being generated for this deal. Give it a moment, then use Retry quote.',
      quoteErrorCode: 'IN_FLIGHT',
    })
    expect(await call(req(create()))).toEqual({ status: 409, body: { ok: false, code: 'IN_PROGRESS' } })
    expect(data.findResumableQuote).not.toHaveBeenCalled()
    expect(retryHubSpotQuote).not.toHaveBeenCalled()
  })

  it('resumes only OUR row, and reports QUOTE_PUBLISH_FAILED when the retry also fails', async () => {
    data.findResumableQuote.mockResolvedValue(ourRow())
    expect(await call(req(create()))).toEqual({ status: 502, body: { ok: false, code: 'QUOTE_PUBLISH_FAILED' } })
    expect(retryHubSpotQuote).toHaveBeenCalledTimes(1)
    expect(retryHubSpotQuote).toHaveBeenCalledWith(DEAL)

    retryHubSpotQuote.mockResolvedValue({ success: true, quote: { ...publishedQuote, amountMismatch: true } })
    const again = await call(req(create()))
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ code: 'CREATED', amountMismatch: true })
  })

  it('never resumes another user\'s row, an older row, or one holding different lines', async () => {
    retryHubSpotQuote.mockResolvedValue({ success: true, quote: publishedQuote })

    data.findResumableQuote.mockResolvedValue(null)
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })

    data.findResumableQuote.mockResolvedValue({ ...ourRow(), created_by_uid: '99999999-2222-4333-8444-555555555555' })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })

    // A stale draft Jack left behind hours ago, same lines.
    data.findResumableQuote.mockResolvedValue({ ...ourRow(), created_at: new Date(Date.now() - 3600_000).toISOString() })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })

    // The other Quote Sender's row: ours, now, but a different cart.
    data.findResumableQuote.mockResolvedValue({ ...ourRow(), line_items: [{ productId: H9, quantity: 41 }, { productId: HOOKS, quantity: 40 }] })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })

    expect(retryHubSpotQuote).not.toHaveBeenCalled()
  })

  it('refuses a retry that came back with a DIFFERENT row than the one it checked', async () => {
    data.findResumableQuote.mockResolvedValue(ourRow())
    retryHubSpotQuote.mockResolvedValue({
      success: true,
      quote: { ...publishedQuote, dealQuoteId: 'cccccccc-0000-4000-8000-000000000003' },
    })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })
  })

  it('QUOTE_PUBLISH_FAILED when the quote published with no link', async () => {
    createQuote.mockResolvedValue({
      success: true,
      quoteReference: 'JA202600123',
      quote: { ...publishedQuote, quoteLink: null },
    })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'QUOTE_PUBLISH_FAILED' })
    expect(retryHubSpotQuote).not.toHaveBeenCalled()
  })
})

describe('mark_sent', () => {
  it('NO_JACK_QUOTE without a published Jack quote on the deal', async () => {
    data.hasPublishedJackQuote.mockResolvedValue(false)
    expect(await call(req(markSent))).toEqual({ status: 422, body: { ok: false, code: 'NO_JACK_QUOTE' } })
    expect(mintJackClient).not.toHaveBeenCalled()
  })

  it('MARKED, then ALREADY_BEYOND on a second call', async () => {
    expect(await call(req(markSent))).toEqual({ status: 200, body: { ok: true, code: 'MARKED', dealstage: '39459182' } })
    expect(markQuoteSent).toHaveBeenCalledWith({ dealId: DEAL })
    markQuoteSent.mockResolvedValue({ success: true, alreadyBeyond: true })
    expect((await call(req(markSent))).body).toEqual({ ok: true, code: 'ALREADY_BEYOND', dealstage: '39459182' })
    expect(signOut).toHaveBeenCalledTimes(2)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it('NOT_BOUND applies to mark_sent too', async () => {
    data.isConversationBound.mockResolvedValue(false)
    expect((await call(req(markSent))).status).toBe(403)
  })

  it('HUBSPOT_ERROR when markQuoteSent refuses', async () => {
    markQuoteSent.mockResolvedValue({ success: false, error: 'HTTP 500' })
    expect(await call(req(markSent))).toEqual({ status: 502, body: { ok: false, code: 'HUBSPOT_ERROR' } })
  })
})

describe('middleware', () => {
  it('lists /api/agent/quote as self-authenticated, by exact path', () => {
    const src = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8')
    const m = src.match(/const SELF_AUTHENTICATED_PATHS = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    const entries = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(entries).toContain('/api/agent/quote')
    expect(entries).toContain('/api/mrp/run')
  })
})
