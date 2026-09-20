import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import { runWithAgentClient } from '@/lib/supabase/agent-scope'
import { mintJackClient } from '@/lib/agent-quote/session'
import {
  ANZ_QUOTABLE_STAGES,
  ANZ_QUOTATION_SENT_STAGE,
  CODE_STATUS,
  acceptByFrom,
  amountCeiling,
  authorizeBearer,
  checkAmountCeiling,
  checkCaps,
  checkDealProgress,
  checkDealShape,
  checkListPriced,
  checkProductSkus,
  checkProductsAllowed,
  checkUrgentCap,
  hasAmountMismatch,
  hasLapsed,
  isUuid,
  linesFromRow,
  linesKey,
  parseAgentQuoteBody,
  quoteComments,
  quoteReferenceOf,
  urgentExpiryDate,
  urgentPerUnitDiscounts,
  type AgentQuoteCode,
  type AgentQuoteLine,
  type QuotePricing,
} from '@/lib/agent-quote/guards'
import {
  countJackQuotes,
  countUrgentQuotes,
  findLatestJackQuote,
  findRepeatQuote,
  findResumableQuote,
  hasActiveContractPrices,
  hasForeignQuote,
  hasInFlightQuote,
  hasPublishedJackQuote,
  isConversationBound,
  readHubSpotProducts,
  type RepeatRow,
} from '@/lib/agent-quote/data'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { loadPricingForQuote } from '@/app/actions/pricing/get-pricing'
import { createQuote } from '@/app/actions/sales/create-quote'
import { retryHubSpotQuote } from '@/app/actions/sales/publish-quote'
import { markQuoteSent } from '@/app/actions/sales/mark-quote-sent'
import { priceCart } from '@/lib/quote-pricing'
import { quoteTemplateIdFor } from '@/lib/pipeline-config'

// ---------------------------------------------------------------------------
// POST /api/agent/quote: Jack, the ANZ AI sales agent, raises and marks
// quotes through the SAME createQuote and markQuoteSent a rep uses.
//
// Auth: `authorization: Bearer ${AGENT_QUOTE_SECRET}` (or the previous secret
// during a rotation), sha256 plus timingSafeEqual, failing closed when unset.
// Listed in middleware SELF_AUTHENTICATED_PATHS.
//
// Three actions:
//   create    list or urgent pricing, bound to a conversation.
//   mark_sent move the deal to Quotation sent after the email went out.
//   reissue   replace a LAPSED urgent quote at standard prices. Bound by the
//             urgent quote on the deal rather than by a conversation, because
//             the caller is the hourly pipeline worker and the call is over.
//
// Order, every refusal before any write:
//   auth, strict body, conversation bound to the deal (agent_tool_calls
//   log_lead in 24 h), then for create: product allowlist, no quote by a
//   person, repeat (holds the earlier quote back for the deal check below),
//   nothing in flight, the urgent cap, the volume caps. Then a per-request Jack
//   session (no password), and inside it: for a repeat, that the deal has not
//   moved on; otherwise deal shape, contract customer, HubSpot SKUs,
//   list-price-only pre-check, the floor discount for urgent, amount ceiling,
//   AU template, and finally the unchanged createQuote.
//
// Responses are fixed codes only. Nothing from the request, HubSpot or
// Supabase is echoed, and headers and bodies are never logged.
// ---------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * How far before this request started a resumable row may have been written
 * and still count as ours.
 *
 * deal_quotes.created_at is stamped by Postgres and `now` is read on the app
 * server, so the two clocks are not the same clock. A few seconds of tolerance
 * keeps a legitimate retry working; the checks that actually establish
 * ownership are the creator, the lines, and the row id the retry comes back
 * with, all of which are exact.
 */
const CLOCK_SKEW_MS = 5000

function fail(code: AgentQuoteCode): NextResponse {
  return NextResponse.json({ ok: false, code }, { status: CODE_STATUS[code], headers: NO_STORE })
}

function ok(body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: true, ...body }, { status: 200, headers: NO_STORE })
}

function uniqueIds(results: { id: string }[] | undefined): string[] {
  return Array.from(new Set((results ?? []).map((r) => String(r.id)).filter(Boolean)))
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * An existing row handed back as REPEAT or REISSUED.
 *
 * amount falls back to hub_amount exactly as the CREATED path does, and
 * amountMismatch runs the same comparison as the publish tail, so the Sender
 * cannot be told to hold an email on one call and send it on the retry.
 */
function rowResponse(code: 'REPEAT' | 'REISSUED', row: RepeatRow): NextResponse {
  return ok({
    code,
    quoteReference: quoteReferenceOf(row.quote_number),
    quoteNumber: row.quote_number,
    quoteLink: row.quote_link,
    pdfLink: row.pdf_link,
    amount: num(row.amount) ?? num(row.hub_amount),
    currency: 'AUD',
    expiresOn: row.expires_on,
    dealQuoteId: row.id,
    amountMismatch: hasAmountMismatch(row.amount, row.hub_amount),
    pricing: row.pricing_mode === 'urgent' ? 'urgent' : 'list',
    acceptBy: row.accept_by ?? null,
  })
}

/**
 * Has the deal moved out from under an earlier quote?
 *
 * Null when Jack may still answer on it. Reads the deal through the same
 * action createForJack uses, so a repeat and a fresh quote agree about what a
 * quotable deal is, and needs the Jack session for the same reason.
 */
async function dealProgress(dealId: string): Promise<AgentQuoteCode | null> {
  const deal = await getDealDetails(dealId)
  if (!deal.success || !deal.data) {
    return deal.error === 'Deal not found' ? 'NOT_ANZ_DEAL' : 'HUBSPOT_ERROR'
  }
  const props = deal.data.properties ?? ({} as typeof deal.data.properties)
  return checkDealProgress({
    pipeline: props.pipeline,
    dealstage: props.dealstage,
    hubspot_owner_id: props.hubspot_owner_id,
  })
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

  const jackUserId = String(process.env.JACK_USER_ID ?? '').trim()
  if (!isUuid(jackUserId)) {
    console.error('agent-quote: JACK_USER_ID is not configured')
    return fail('INTERNAL')
  }

  let step = 'precheck'
  try {
    const admin = createAdminClient()
    const now = new Date()

    // Reissue carries no conversation: the lapsed urgent quote on the deal is
    // its binding, and it is checked below instead.
    if (body.action !== 'reissue' && !(await isConversationBound(admin, body.conversationId, body.dealId, now))) {
      return fail('NOT_BOUND')
    }

    /** Set for create and reissue: what to quote and how. */
    let plan: { lines: AgentQuoteLine[]; pricing: QuotePricing; reissueOf: string | null; stages: readonly string[] } | null = null
    /** Set instead of `plan` when this cart has already been quoted. */
    let repeat: RepeatRow | null = null

    if (body.action === 'create') {
      const notAllowed = checkProductsAllowed(body.lines)
      if (notAllowed) return fail(notAllowed)

      // BEFORE the repeat lookup, and cheaper than it: a person who has
      // re-quoted the deal since must be seen first, or Jack hands the customer
      // his own older link while the rep's quote is the live one. The deal's
      // own stage, owner and closed state are checked further down, inside the
      // session, because reading them needs one.
      if (await hasForeignQuote(admin, jackUserId, body.dealId)) return fail('FOREIGN_QUOTE')

      const found = await findRepeatQuote(admin, jackUserId, body.dealId, body.lines, body.pricing, now)
      // A published row with no link is a HubSpot quote that exists under that
      // number with a link nobody read back. Quoting again would put a SECOND
      // public quote on the deal for the same cart, so refuse and let the
      // Sender's failure path put it in front of a person.
      if (found && !found.quote_link) return fail('QUOTE_PUBLISH_FAILED')

      if (found) {
        // Answered below, inside the session, once the deal has been read. The
        // caps and the in-flight check are deliberately skipped: a repeat
        // raises nothing, and refusing one on a cap would leave the caller
        // without the link to a quote that already went out.
        repeat = found
      } else {
        if (await hasInFlightQuote(admin, body.dealId)) return fail('IN_PROGRESS')

        if (body.pricing === 'urgent') {
          const urgentCap = checkUrgentCap(await countUrgentQuotes(admin, jackUserId, body.dealId, now))
          if (urgentCap) return fail(urgentCap)
        }

        const capped = checkCaps(await countJackQuotes(admin, jackUserId, body.dealId, now))
        if (capped) return fail(capped)

        plan = { lines: body.lines, pricing: body.pricing, reissueOf: null, stages: ANZ_QUOTABLE_STAGES }
      }
    } else if (body.action === 'reissue') {
      const latest = await findLatestJackQuote(admin, jackUserId, body.dealId)
      if (!latest) return fail('NO_URGENT_QUOTE')

      // A reissue lands as a NEWER row than the urgent quote it replaces, so a
      // newest row carrying reissue_of means this deal has already been
      // reissued. Answer a repeated call with that quote rather than a refusal
      // (the pipeline worker retries), and refuse only when it never published.
      if (latest.reissue_of) {
        return latest.status === 'published' && latest.quote_link
          ? rowResponse('REISSUED', latest)
          : fail('REISSUE_CAP')
      }

      if (latest.pricing_mode !== 'urgent') return fail('NO_URGENT_QUOTE')
      if (latest.status !== 'published' || !latest.quote_link) return fail('NO_URGENT_QUOTE')
      if (!hasLapsed(latest.accept_by, now)) return fail('NOT_LAPSED')

      const lines = linesFromRow(latest.line_items)
      if (lines.length === 0) return fail('NO_URGENT_QUOTE')
      const notAllowed = checkProductsAllowed(lines)
      if (notAllowed) return fail(notAllowed)

      if (await hasForeignQuote(admin, jackUserId, body.dealId)) return fail('FOREIGN_QUOTE')
      if (await hasInFlightQuote(admin, body.dealId)) return fail('IN_PROGRESS')

      const capped = checkCaps(await countJackQuotes(admin, jackUserId, body.dealId, now))
      if (capped) return fail(capped)

      // The customer is holding a lapsed quote on Quotation sent and nowhere
      // else, so a reissue is refused from any other stage.
      plan = { lines, pricing: 'list', reissueOf: latest.id, stages: [ANZ_QUOTATION_SENT_STAGE] }
    } else if (!(await hasPublishedJackQuote(admin, jackUserId, body.dealId))) {
      return fail('NO_JACK_QUOTE')
    }

    step = 'session'
    const session = await mintJackClient()
    try {
      return await runWithAgentClient(session.client, async () => {
        step = 'identity'
        const supabase = await createServerClient()
        const { data: me } = await supabase.auth.getUser()
        if (me?.user?.id !== jackUserId) return fail('INTERNAL')

        if (repeat) {
          step = 'repeat'
          const moved = await dealProgress(body.dealId)
          return moved ? fail(moved) : rowResponse('REPEAT', repeat)
        }

        if (body.action === 'mark_sent') {
          step = 'mark_sent'
          const marked = await markQuoteSent({ dealId: body.dealId })
          if (!marked.success) {
            console.error('agent-quote: markQuoteSent refused')
            return fail('HUBSPOT_ERROR')
          }
          return ok({ code: marked.alreadyBeyond ? 'ALREADY_BEYOND' : 'MARKED', dealstage: ANZ_QUOTATION_SENT_STAGE })
        }

        return await createForJack({
          admin,
          jackUserId,
          dealId: body.dealId,
          startedAt: now,
          urgencyNote: body.action === 'create' ? body.urgencyNote ?? null : null,
          code: body.action === 'reissue' ? 'REISSUED' : 'CREATED',
          ...plan!,
          setStep: (s) => (step = s),
        })
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

interface CreateForJackInput {
  admin: ReturnType<typeof createAdminClient>
  jackUserId: string
  dealId: string
  lines: AgentQuoteLine[]
  pricing: QuotePricing
  reissueOf: string | null
  stages: readonly string[]
  urgencyNote: string | null
  code: 'CREATED' | 'REISSUED'
  startedAt: Date
  setStep: (step: string) => void
}

async function createForJack(input: CreateForJackInput): Promise<NextResponse> {
  const { admin, jackUserId, dealId, lines, pricing, setStep } = input

  setStep('deal')
  const deal = await getDealDetails(dealId)
  if (!deal.success || !deal.data) {
    // Out-of-scope deals read as "not found" for a non-admin: not an ANZ deal.
    return fail(deal.error === 'Deal not found' ? 'NOT_ANZ_DEAL' : 'HUBSPOT_ERROR')
  }
  const props = deal.data.properties ?? ({} as typeof deal.data.properties)
  const contactIds = uniqueIds(deal.data.associations?.contacts?.results)
  const companyIds = uniqueIds(deal.data.associations?.companies?.results)

  const shape = checkDealShape(
    {
      pipeline: props.pipeline,
      dealstage: props.dealstage,
      hubspot_owner_id: props.hubspot_owner_id,
      deal_currency_code: props.deal_currency_code,
      contactIds,
    },
    input.stages,
  )
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
  const pricingRows = await loadPricingForQuote({ companyId, currency: 'AUD', userId: jackUserId })
  const cart = (discounts: number[] | null) =>
    priceCart({
      lines: lines.map((l, i) => ({
        productId: l.productId,
        name: products[l.productId].name,
        sku: products[l.productId].sku,
        quantity: l.quantity,
        unitPrice: 0,
        ...(discounts && discounts[i] > 0 ? { discountMode: 'amount' as const, discountValue: discounts[i] } : {}),
      })),
      currency: 'AUD',
      companyId,
      listPrices: pricingRows.listPrices,
      contractPrices: pricingRows.contractPrices,
      cap: pricingRows.cap,
      isSuperAdmin: false,
      today: new Date().toISOString().slice(0, 10),
    })

  const base = cart(null)
  if (!base.ok) return fail('NO_PRICE')
  const unpriced = checkListPriced(base.lines)
  if (unpriced) return fail(unpriced)

  // Urgent: every line drops from its unit price to its floor price as a CASH
  // per-unit discount, so the net IS the floor and nothing has to trust a
  // number the caller named. A line with no floor stops the whole quote rather
  // than going out at an invented one.
  let priced = base
  if (pricing === 'urgent') {
    setStep('floor')
    const discounts = urgentPerUnitDiscounts(base.lines)
    if (!discounts) return fail('NO_FLOOR')
    const floored = cart(discounts)
    // priceCart runs checkDiscount, which is where Jack's rep_discount_caps row
    // and the floor itself are enforced. A refusal here means the cap row is
    // missing or too small, not that the caller asked for something odd.
    if (!floored.ok) {
      console.error('agent-quote: floor discount refused')
      return fail('DISCOUNT_REFUSED')
    }
    priced = floored
  }

  const overCeiling = checkAmountCeiling(priced.total, amountCeiling(process.env.AGENT_QUOTE_AMOUNT_CEILING))
  if (overCeiling) return fail(overCeiling)

  if (!quoteTemplateIdFor('AU')) return fail('TEMPLATE_MISSING')

  const acceptBy = pricing === 'urgent' ? acceptByFrom(input.startedAt) : null

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
      ...(l.priced.listUnitPrice > l.priced.netUnitPrice
        ? {
            discountMode: 'amount' as const,
            discountValue: Number((l.priced.listUnitPrice - l.priced.netUnitPrice).toFixed(2)),
          }
        : {}),
    })),
    totalAmount: priced.total,
    comments: quoteComments(pricing, acceptBy),
    isCollection: false,
    isPreview: false,
    // The urgent price holds for 24 hours and HubSpot's expiry is a date, so
    // the quote expires on the SYDNEY day the deadline falls on. Derived from
    // the same acceptBy the comment line and the email print, so the three can
    // never name different days. A list quote keeps the house 60 days.
    ...(pricing === 'urgent' && acceptBy ? { expiryDate: urgentExpiryDate(acceptBy) } : {}),
    agentQuote: { pricingMode: pricing, acceptBy, reissueOf: input.reissueOf, urgencyNote: input.urgencyNote },
  })
  if (!result.success) {
    console.error('agent-quote: createQuote refused')
    return fail('HUBSPOT_ERROR')
  }

  let quote = 'quote' in result ? result.quote : undefined
  if (!quote) {
    // The deal writes are committed but no HubSpot quote came back.
    const errorCode = 'quoteErrorCode' in result ? result.quoteErrorCode : undefined
    // Another generate or an edit owns this deal. A retry here would resume
    // THAT row and report its lines, its number and its link as ours, so say
    // so instead and let the Sender hold.
    if (errorCode === 'IN_FLIGHT') return fail('IN_PROGRESS')

    setStep('retry')
    // retryHubSpotQuote picks the newest draft or failed row on the deal and
    // filters on nothing else, so prove the row is ours before calling it.
    const resumable = await findResumableQuote(admin, dealId)
    const isOurs =
      resumable !== null &&
      resumable.created_by_uid === jackUserId &&
      Date.parse(resumable.created_at) >= input.startedAt.getTime() - CLOCK_SKEW_MS &&
      linesKey(linesFromRow(resumable.line_items)) === linesKey(lines)
    if (!isOurs) return fail('QUOTE_PUBLISH_FAILED')

    const retried = await retryHubSpotQuote(dealId)
    // And prove it finished the row we checked, not one written in between.
    quote = retried.success && retried.quote.dealQuoteId === resumable.id ? retried.quote : undefined
  }
  if (!quote?.quoteLink) return fail('QUOTE_PUBLISH_FAILED')

  return ok({
    code: input.code,
    quoteReference: result.quoteReference,
    quoteNumber: quote.quoteNumber ?? result.quoteReference,
    quoteLink: quote.quoteLink,
    pdfLink: quote.pdfLink,
    amount: quote.amount ?? quote.hubAmount,
    currency: 'AUD',
    expiresOn: quote.expiresOn,
    dealQuoteId: quote.dealQuoteId,
    amountMismatch: quote.amountMismatch,
    pricing,
    acceptBy,
  })
}
