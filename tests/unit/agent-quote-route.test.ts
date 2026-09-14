import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * POST /api/agent/quote, the whole route with its collaborators mocked.
 *
 * The live stage-1 check can only reach NOT_BOUND while no log_lead row binds a
 * conversation to the fixture deal, so this is where the downstream path is
 * proven: the order of refusals, that nothing writes before the last guard,
 * that the real agent seam hands the Bruce client to every createServerClient
 * call, and that the session is always signed out.
 */

const SECRET = 'f'.repeat(64)
const BRUCE_ID = '11111111-2222-4333-8444-555555555555'
const DEAL = '64951402250'
const CONV = 'conv_7001abc'
const H9 = '1640186928'
const HOOKS = '29207708995'

// --- next/headers: the agent path must never read cookies --------------------
const cookies = vi.fn(async () => {
  throw new Error('cookies() must not be called on the agent path')
})
vi.mock('next/headers', () => ({ cookies: () => cookies() }))

// --- the Bruce session -------------------------------------------------------
const signOut = vi.fn(async () => {})
const bruceGetUser = vi.fn(async () => ({ data: { user: { id: BRUCE_ID } }, error: null }))
const bruceClient = { auth: { getUser: bruceGetUser } }
const mintBruceClient = vi.fn(async () => ({ client: bruceClient, userId: BRUCE_ID, signOut }))
vi.mock('@/lib/agent-quote/session', () => ({ mintBruceClient: () => mintBruceClient() }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))

// --- data reads --------------------------------------------------------------
const data = {
  isConversationBound: vi.fn(),
  countBruceQuotes: vi.fn(),
  findRepeatQuote: vi.fn(),
  hasForeignQuote: vi.fn(),
  hasPublishedBruceQuote: vi.fn(),
  hasActiveContractPrices: vi.fn(),
  readHubSpotProducts: vi.fn(),
}
vi.mock('@/lib/agent-quote/data', () => ({
  isConversationBound: (...a: unknown[]) => data.isConversationBound(...a),
  countBruceQuotes: (...a: unknown[]) => data.countBruceQuotes(...a),
  findRepeatQuote: (...a: unknown[]) => data.findRepeatQuote(...a),
  hasForeignQuote: (...a: unknown[]) => data.hasForeignQuote(...a),
  hasPublishedBruceQuote: (...a: unknown[]) => data.hasPublishedBruceQuote(...a),
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
const products = {
  [H9]: { sku: 'EBH9NA', name: 'Echo Barrier H9' },
  [HOOKS]: { sku: 'HKNA', name: 'Echo Barrier Metal Hooks (Part of Fitting Kit)' },
}
const audRows = [
  { sku: 'EBH9NA', currency: 'AUD', unit_price: 250, floor_price: 200, is_active: true },
  { sku: 'HKNA', currency: 'AUD', unit_price: 5, floor_price: 4, is_active: true },
]
const publishedQuote = {
  dealQuoteId: '9b2f0c1e-0000-4000-8000-000000000001',
  quoteId: '123',
  quoteNumber: 'BA202600123',
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
})
const markSent = { action: 'mark_sent', conversationId: CONV, dealId: DEAL }

async function call(r: Request) {
  const res = await POST(r)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  seenClients.length = 0
  templateId = null
  process.env.AGENT_QUOTE_SECRET = SECRET
  delete process.env.AGENT_QUOTE_SECRET_PREVIOUS
  process.env.BRUCE_USER_ID = BRUCE_ID
  delete process.env.AGENT_QUOTE_AMOUNT_CEILING
  data.isConversationBound.mockResolvedValue(true)
  data.countBruceQuotes.mockResolvedValue({ dealLast7Days: 0, allLast24Hours: 0 })
  data.findRepeatQuote.mockResolvedValue(null)
  data.hasForeignQuote.mockResolvedValue(false)
  data.hasPublishedBruceQuote.mockResolvedValue(true)
  data.hasActiveContractPrices.mockResolvedValue(false)
  data.readHubSpotProducts.mockResolvedValue(products)
  getDealDetails.mockResolvedValue(fixtureDeal)
  loadPricingForQuote.mockResolvedValue({ listPrices: [], contractPrices: [], contractorName: null, cap: null })
  createQuote.mockResolvedValue({ success: true, quoteReference: 'BA202600123', quote: publishedQuote })
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

  it('400 for broken JSON, extra keys and limits, without echoing input', async () => {
    expect(await call(req('{not json'))).toEqual({ status: 400, body: { ok: false, code: 'BAD_REQUEST' } })
    expect((await call(req({ ...create(), comments: 'x' }))).body).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect((await call(req(create([{ productId: H9, quantity: 201 }])))).status).toBe(400)
    expect(data.isConversationBound).not.toHaveBeenCalled()
  })

  it('500 when BRUCE_USER_ID is not a uuid', async () => {
    process.env.BRUCE_USER_ID = 'bruce'
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
  })
})

describe('before the session', () => {
  it('403 NOT_BOUND when no log_lead row binds the conversation to the deal', async () => {
    data.isConversationBound.mockResolvedValue(false)
    expect(await call(req(create()))).toEqual({ status: 403, body: { ok: false, code: 'NOT_BOUND' } })
    expect(data.isConversationBound).toHaveBeenCalledWith({ tag: 'admin' }, CONV, DEAL, expect.any(Date))
    expect(mintBruceClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('422 PRODUCT_NOT_ALLOWED for a product off the ANZ list', async () => {
    expect(await call(req(create([{ productId: '999', quantity: 1 }])))).toEqual({ status: 422, body: { ok: false, code: 'PRODUCT_NOT_ALLOWED' } })
    expect(mintBruceClient).not.toHaveBeenCalled()
  })

  it('200 REPEAT returns the earlier published quote without a session', async () => {
    data.findRepeatQuote.mockResolvedValue({
      id: publishedQuote.dealQuoteId, quote_number: 'BA202600123-2', quote_link: publishedQuote.quoteLink, pdf_link: null,
      amount: '10200.00', hub_amount: '10200', currency: 'AUD', expires_on: '2026-10-14', line_items: [],
    })
    const { status, body } = await call(req(create()))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true, code: 'REPEAT', quoteReference: 'BA202600123', quoteNumber: 'BA202600123-2', quoteLink: publishedQuote.quoteLink,
      pdfLink: null, amount: 10200, currency: 'AUD', expiresOn: '2026-10-14', dealQuoteId: publishedQuote.dealQuoteId, amountMismatch: false,
    })
    expect(mintBruceClient).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('409 CAP_REACHED at 3 on the deal or 20 in the day', async () => {
    data.countBruceQuotes.mockResolvedValue({ dealLast7Days: 3, allLast24Hours: 3 })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'CAP_REACHED' })
    data.countBruceQuotes.mockResolvedValue({ dealLast7Days: 0, allLast24Hours: 20 })
    expect((await call(req(create()))).status).toBe(409)
    expect(mintBruceClient).not.toHaveBeenCalled()
  })

  it('422 FOREIGN_QUOTE when a person already quoted the deal', async () => {
    data.hasForeignQuote.mockResolvedValue(true)
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'FOREIGN_QUOTE' })
    expect(mintBruceClient).not.toHaveBeenCalled()
  })

  it('500 INTERNAL when a Supabase read fails, never a silent pass', async () => {
    data.isConversationBound.mockRejectedValue(new Error('boom'))
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
  })
})

describe('inside the Bruce session', () => {
  it('hands the Bruce client to every createServerClient call and never reads cookies', async () => {
    templateId = '999000111'
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
    await call(req(create()))
    expect(seenClients.length).toBeGreaterThanOrEqual(2)
    for (const c of seenClients) expect(c).toBe(bruceClient)
    expect(cookies).not.toHaveBeenCalled()
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('NO_PRICE while no AUD list rows exist (today), with no write and a signed-out session', async () => {
    expect(await call(req(create()))).toEqual({ status: 422, body: { ok: false, code: 'NO_PRICE' } })
    expect(loadPricingForQuote).toHaveBeenCalledWith({ companyId: 'UNKNOWN', currency: 'AUD', userId: BRUCE_ID })
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
    templateId = '999000111'
    process.env.AGENT_QUOTE_AMOUNT_CEILING = '5000'
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
    expect((await call(req(create()))).body).toEqual({ ok: false, code: 'AMOUNT_CEILING' })
    expectNoWrites()
  })

  it('CREATED calls the unchanged createQuote with fixed server-side values and list prices', async () => {
    templateId = '999000111'
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
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
    })
    expect(body).toEqual({
      ok: true, code: 'CREATED', quoteReference: 'BA202600123', quoteNumber: 'BA202600123', quoteLink: publishedQuote.quoteLink,
      pdfLink: publishedQuote.pdfLink, amount: 10200, currency: 'AUD', expiresOn: '2026-10-14', dealQuoteId: publishedQuote.dealQuoteId, amountMismatch: false,
    })
    expect(retryHubSpotQuote).not.toHaveBeenCalled()
  })

  it('retries the publish once on quoteError, and reports QUOTE_PUBLISH_FAILED if that fails', async () => {
    templateId = '999000111'
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
    createQuote.mockResolvedValue({ success: true, quoteReference: 'BA202600123', quoteError: 'publish failed' })
    expect(await call(req(create()))).toEqual({ status: 502, body: { ok: false, code: 'QUOTE_PUBLISH_FAILED' } })
    expect(retryHubSpotQuote).toHaveBeenCalledTimes(1)
    expect(retryHubSpotQuote).toHaveBeenCalledWith(DEAL)

    retryHubSpotQuote.mockResolvedValue({ success: true, quote: { ...publishedQuote, amountMismatch: true } })
    const again = await call(req(create()))
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ code: 'CREATED', amountMismatch: true })
  })

  it('HUBSPOT_ERROR when createQuote refuses (the staging kill switch lands here)', async () => {
    templateId = '999000111'
    loadPricingForQuote.mockResolvedValue({ listPrices: audRows, contractPrices: [], contractorName: null, cap: null })
    createQuote.mockResolvedValue({ success: false, error: 'Sandbox (staging): the live hand-off was skipped' })
    expect(await call(req(create()))).toEqual({ status: 502, body: { ok: false, code: 'HUBSPOT_ERROR' } })
  })

  it('INTERNAL and a sign-out when the session user is not Bruce', async () => {
    bruceGetUser.mockResolvedValueOnce({ data: { user: { id: 'someone-else' } }, error: null })
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(getDealDetails).not.toHaveBeenCalled()
  })

  it('INTERNAL when the session cannot be minted', async () => {
    mintBruceClient.mockRejectedValueOnce(new Error('verify'))
    expect(await call(req(create()))).toEqual({ status: 500, body: { ok: false, code: 'INTERNAL' } })
    expectNoWrites()
  })

  it('signs out even when an action throws', async () => {
    getDealDetails.mockRejectedValueOnce(new Error('network'))
    expect((await call(req(create()))).status).toBe(500)
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})

describe('mark_sent', () => {
  it('NO_BRUCE_QUOTE without a published Bruce quote on the deal', async () => {
    data.hasPublishedBruceQuote.mockResolvedValue(false)
    expect(await call(req(markSent))).toEqual({ status: 422, body: { ok: false, code: 'NO_BRUCE_QUOTE' } })
    expect(mintBruceClient).not.toHaveBeenCalled()
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
