import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import { runWithAgentClient } from '@/lib/supabase/agent-scope'
import { mintBruceClient } from '@/lib/agent-quote/session'
import {
  AGENT_QUOTE_COMMENTS,
  ANZ_QUOTATION_SENT_STAGE,
  CODE_STATUS,
  amountCeiling,
  authorizeBearer,
  checkAmountCeiling,
  checkCaps,
  checkDealShape,
  checkListPriced,
  checkProductSkus,
  checkProductsAllowed,
  hasAmountMismatch,
  isUuid,
  parseAgentQuoteBody,
  quoteReferenceOf,
  type AgentQuoteCode,
  type AgentQuoteLine,
} from '@/lib/agent-quote/guards'
import {
  countBruceQuotes,
  findRepeatQuote,
  hasActiveContractPrices,
  hasForeignQuote,
  hasPublishedBruceQuote,
  isConversationBound,
  readHubSpotProducts,
} from '@/lib/agent-quote/data'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { loadPricingForQuote } from '@/app/actions/pricing/get-pricing'
import { createQuote } from '@/app/actions/sales/create-quote'
import { retryHubSpotQuote } from '@/app/actions/sales/publish-quote'
import { markQuoteSent } from '@/app/actions/sales/mark-quote-sent'
import { priceCart } from '@/lib/quote-pricing'
import { quoteTemplateIdFor } from '@/lib/pipeline-config'

// ---------------------------------------------------------------------------
// POST /api/agent/quote: Bruce, the ANZ AI sales agent, raises and marks
// quotes through the SAME createQuote and markQuoteSent a rep uses.
//
// Auth: `authorization: Bearer ${AGENT_QUOTE_SECRET}` (or the previous secret
// during a rotation), sha256 plus timingSafeEqual, failing closed when unset.
// Listed in middleware SELF_AUTHENTICATED_PATHS.
//
// Order, every refusal before any write:
//   auth, strict body, conversation bound to the deal (bruce_tool_calls
//   log_lead in 24 h), then for create: product allowlist, repeat (returns the
//   earlier quote), caps, no quote by a person on the deal. Then a per-request
//   Bruce session (no password), and inside it: deal shape, contract customer,
//   HubSpot SKUs, list-price-only pre-check, amount ceiling, AU template, and
//   finally the unchanged createQuote. mark_sent needs a published Bruce quote.
//
// Responses are fixed codes only. Nothing from the request, HubSpot or
// Supabase is echoed, and headers and bodies are never logged.
// ---------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store' }

function fail(code: AgentQuoteCode): NextResponse {
  return NextResponse.json({ ok: false, code }, { status: CODE_STATUS[code], headers: NO_STORE })
}

function ok(body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: true, ...body }, { status: 200, headers: NO_STORE })
}

function uniqueIds(results: { id: string }[] | undefined): string[] {
  return Array.from(new Set((results ?? []).map((r) => String(r.id)).filter(Boolean)))
}

export async function POST(request: Request) {
  const secrets = {
    AGENT_QUOTE_SECRET: process.env.AGENT_QUOTE_SECRET,
    AGENT_QUOTE_SECRET_PREVIOUS: process.env.AGENT_QUOTE_SECRET_PREVIOUS,
  }
  if (!authorizeBearer(request.headers.get('authorization'), secrets)) return fail('UNAUTHORIZED')

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail('BAD_REQUEST')
  }
  const parsed = parseAgentQuoteBody(raw)
  if (!parsed.ok) return fail(parsed.code)
  const body = parsed.value

  const bruceUserId = String(process.env.BRUCE_USER_ID ?? '').trim()
  if (!isUuid(bruceUserId)) {
    console.error('agent-quote: BRUCE_USER_ID is not configured')
    return fail('INTERNAL')
  }

  let step = 'precheck'
  try {
    const admin = createAdminClient()
    const now = new Date()

    if (!(await isConversationBound(admin, body.conversationId, body.dealId, now))) return fail('NOT_BOUND')

    if (body.action === 'create') {
      const notAllowed = checkProductsAllowed(body.lines)
      if (notAllowed) return fail(notAllowed)

      const repeat = await findRepeatQuote(admin, bruceUserId, body.dealId, body.lines, now)
      if (repeat) {
        return ok({
          code: 'REPEAT',
          quoteReference: quoteReferenceOf(repeat.quote_number),
          quoteNumber: repeat.quote_number,
          quoteLink: repeat.quote_link,
          pdfLink: repeat.pdf_link,
          amount: repeat.amount == null ? null : Number(repeat.amount),
          currency: 'AUD',
          expiresOn: repeat.expires_on,
          dealQuoteId: repeat.id,
          amountMismatch: hasAmountMismatch(repeat.amount, repeat.hub_amount),
        })
      }

      const capped = checkCaps(await countBruceQuotes(admin, bruceUserId, body.dealId, now))
      if (capped) return fail(capped)

      if (await hasForeignQuote(admin, bruceUserId, body.dealId)) return fail('FOREIGN_QUOTE')
    } else if (!(await hasPublishedBruceQuote(admin, bruceUserId, body.dealId))) {
      return fail('NO_BRUCE_QUOTE')
    }

    step = 'session'
    const session = await mintBruceClient()
    try {
      return await runWithAgentClient(session.client, async () => {
        step = 'identity'
        const supabase = await createServerClient()
        const { data: me } = await supabase.auth.getUser()
        if (me?.user?.id !== bruceUserId) return fail('INTERNAL')

        if (body.action === 'mark_sent') {
          step = 'mark_sent'
          const marked = await markQuoteSent({ dealId: body.dealId })
          if (!marked.success) {
            console.error('agent-quote: markQuoteSent refused')
            return fail('HUBSPOT_ERROR')
          }
          return ok({ code: marked.alreadyBeyond ? 'ALREADY_BEYOND' : 'MARKED', dealstage: ANZ_QUOTATION_SENT_STAGE })
        }

        return await createForBruce(admin, bruceUserId, body.dealId, body.lines, (s) => (step = s))
      })
    } finally {
      await session.signOut()
    }
  } catch {
    // The step name only: error objects can carry request or HubSpot detail.
    console.error(`agent-quote: internal error at ${step}`)
    return fail('INTERNAL')
  }
}

async function createForBruce(
  admin: ReturnType<typeof createAdminClient>,
  bruceUserId: string,
  dealId: string,
  lines: AgentQuoteLine[],
  setStep: (step: string) => void,
): Promise<NextResponse> {
  setStep('deal')
  const deal = await getDealDetails(dealId)
  if (!deal.success || !deal.data) {
    // Out-of-scope deals read as "not found" for a non-admin: not an ANZ deal.
    return fail(deal.error === 'Deal not found' ? 'NOT_ANZ_DEAL' : 'HUBSPOT_ERROR')
  }
  const props = deal.data.properties ?? ({} as typeof deal.data.properties)
  const contactIds = uniqueIds(deal.data.associations?.contacts?.results)
  const companyIds = uniqueIds(deal.data.associations?.companies?.results)

  const shape = checkDealShape({
    pipeline: props.pipeline,
    dealstage: props.dealstage,
    hubspot_owner_id: props.hubspot_owner_id,
    deal_currency_code: props.deal_currency_code,
    contactIds,
  })
  if (shape) return fail(shape)

  setStep('contract')
  if (await hasActiveContractPrices(admin, companyIds)) return fail('CONTRACT_CUSTOMER')

  setStep('products')
  const products = await readHubSpotProducts(lines.map((l) => l.productId))
  if (!products) return fail('HUBSPOT_ERROR')
  const skuByProductId = Object.fromEntries(Object.entries(products).map(([id, p]) => [id, p.sku]))
  const skuProblem = checkProductSkus(lines, skuByProductId)
  if (skuProblem) return fail(skuProblem)

  // The same loader and pure pricer createQuote runs, with unitPrice 0 so a
  // line that is not list-priced can never quote at a caller-named price.
  setStep('pricing')
  const companyId = companyIds[0] ?? 'UNKNOWN'
  const pricing = await loadPricingForQuote({ companyId, currency: 'AUD', userId: bruceUserId })
  const priced = priceCart({
    lines: lines.map((l) => ({
      productId: l.productId,
      name: products[l.productId].name,
      sku: products[l.productId].sku,
      quantity: l.quantity,
      unitPrice: 0,
    })),
    currency: 'AUD',
    companyId,
    listPrices: pricing.listPrices,
    contractPrices: pricing.contractPrices,
    cap: pricing.cap,
    isSuperAdmin: false,
    today: new Date().toISOString().slice(0, 10),
  })
  if (!priced.ok) return fail('NO_PRICE')
  const unpriced = checkListPriced(priced.lines)
  if (unpriced) return fail(unpriced)

  const overCeiling = checkAmountCeiling(priced.total, amountCeiling(process.env.AGENT_QUOTE_AMOUNT_CEILING))
  if (overCeiling) return fail(overCeiling)

  if (!quoteTemplateIdFor('AU')) return fail('TEMPLATE_MISSING')

  setStep('createQuote')
  const result = await createQuote({
    dealId,
    distributor: 'Direct Sale',
    depot: 'AU-SYD',
    template: 'AU',
    lineItems: priced.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.priced.listUnitPrice,
      total: l.lineTotal,
      sku: l.sku,
    })),
    totalAmount: priced.total,
    comments: AGENT_QUOTE_COMMENTS.join('\n'),
    isCollection: false,
    isPreview: false,
  })
  if (!result.success) {
    console.error('agent-quote: createQuote refused')
    return fail('HUBSPOT_ERROR')
  }

  let quote = 'quote' in result ? result.quote : undefined
  if (!quote) {
    // Deal writes are committed but the HubSpot quote did not publish. Resume
    // it once from the deal_quotes row rather than generating again.
    setStep('retry')
    const retried = await retryHubSpotQuote(dealId)
    quote = retried.success ? retried.quote : undefined
  }
  if (!quote?.quoteLink) return fail('QUOTE_PUBLISH_FAILED')

  return ok({
    code: 'CREATED',
    quoteReference: result.quoteReference,
    quoteNumber: quote.quoteNumber ?? result.quoteReference,
    quoteLink: quote.quoteLink,
    pdfLink: quote.pdfLink,
    amount: quote.amount ?? quote.hubAmount,
    currency: 'AUD',
    expiresOn: quote.expiresOn,
    dealQuoteId: quote.dealQuoteId,
    amountMismatch: quote.amountMismatch,
  })
}
