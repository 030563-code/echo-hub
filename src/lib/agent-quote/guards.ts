import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HUBSPOT_PIPELINES, CLOSED_WON_STAGES, CLOSED_LOST_STAGES } from '@/lib/hubspot-constants'
import { allowedCurrenciesForPipeline } from '@/lib/pipeline-config'
import { roundCents } from '@/lib/quote-math'
import type { PricedCartLine } from '@/lib/quote-pricing'

/**
 * Pure guards for POST /api/agent/quote (Jack, the ANZ AI sales agent).
 *
 * Everything the route decides before it touches HubSpot lives here, so each
 * rule is unit tested without a network: the bearer compare, the strict body,
 * the line limits, the deal shape, the price source, the urgent floor maths and
 * the amount ceiling. The route stays thin and only wires these to the data.
 *
 * Failures are fixed codes and nothing else. The caller (n8n) never gets input
 * echoed back or raw HubSpot or Supabase text.
 */

export type AgentQuoteCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_BOUND'
  | 'CAP_REACHED'
  /** A draft or editing deal_quotes row is already in flight on this deal. */
  | 'IN_PROGRESS'
  /** One urgent-priced quote per deal per 30 days is already used. */
  | 'URGENT_CAP'
  /** That urgent quote has already been reissued once. */
  | 'REISSUE_CAP'
  | 'NOT_ANZ_DEAL'
  | 'DEAL_CLOSED'
  | 'BAD_STAGE'
  | 'WRONG_OWNER'
  | 'NOT_AUD'
  | 'CONTACT_COUNT'
  | 'CONTRACT_CUSTOMER'
  | 'FOREIGN_QUOTE'
  | 'PRODUCT_NOT_ALLOWED'
  | 'NO_PRICE'
  /** Urgent asked for, but a line has no floor price, or a floor above its unit
   *  price. Never guess a floor: the quote goes out at list or not at all. */
  | 'NO_FLOOR'
  /** The floor discount was refused by the discount cap or the floor check. */
  | 'DISCOUNT_REFUSED'
  | 'AMOUNT_CEILING'
  | 'TEMPLATE_MISSING'
  | 'NO_JACK_QUOTE'
  /** Reissue asked for with no urgent Jack quote on the deal to reissue. */
  | 'NO_URGENT_QUOTE'
  /** Reissue asked for while the urgent quote is still inside its 24 hours. */
  | 'NOT_LAPSED'
  | 'QUOTE_PUBLISH_FAILED'
  | 'HUBSPOT_ERROR'
  | 'INTERNAL'

export const CODE_STATUS: Record<AgentQuoteCode, number> = {
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  NOT_BOUND: 403,
  CAP_REACHED: 409,
  IN_PROGRESS: 409,
  URGENT_CAP: 409,
  REISSUE_CAP: 409,
  NOT_ANZ_DEAL: 422,
  DEAL_CLOSED: 422,
  BAD_STAGE: 422,
  WRONG_OWNER: 422,
  NOT_AUD: 422,
  CONTACT_COUNT: 422,
  CONTRACT_CUSTOMER: 422,
  FOREIGN_QUOTE: 422,
  PRODUCT_NOT_ALLOWED: 422,
  NO_PRICE: 422,
  NO_FLOOR: 422,
  DISCOUNT_REFUSED: 422,
  AMOUNT_CEILING: 422,
  TEMPLATE_MISSING: 422,
  NO_JACK_QUOTE: 422,
  NO_URGENT_QUOTE: 422,
  NOT_LAPSED: 422,
  QUOTE_PUBLISH_FAILED: 502,
  HUBSPOT_ERROR: 502,
  INTERNAL: 500,
}

// ---------------------------------------------------------------------------
// Fixed ids (contracts.md C1)
// ---------------------------------------------------------------------------

export const ANZ_PIPELINE_ID = HUBSPOT_PIPELINES.AUSTRALIA_SALES.id // '14520121'
export const ANZ_OWNER_ID = '30234944' // Geoff
export const ANZ_QUOTATION_SENT_STAGE = HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.QUOTATION_SENT // '39459182'

/** Stages a quote may be raised from: Appointment through Quotation sent. */
export const ANZ_QUOTABLE_STAGES: readonly string[] = [
  HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.APPOINTMENT_SCHEDULED,
  HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.QUALIFIED_TO_BUY,
  HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.PRESENTATION_SCHEDULED,
  HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.DECISION_MAKER_BOUGHT_IN,
  HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.QUOTATION_SENT,
]

/** HubSpot product id to the SKU HubSpot must hold for it. */
export const ANZ_PRODUCT_ALLOWLIST: Readonly<Record<string, string>> = {
  '29207461216': 'EBH8NA',
  '1640186928': 'EBH9NA',
  '19850990926': 'EBH9XNA',
  '29231439287': 'EBH10NA',
  '29207708995': 'HKNA',
  '29231439368': 'BUNNA',
}

/** The barrier panels, which count toward the 200 panel limit. Hooks and
 *  bungees are fittings and do not. */
export const ANZ_PANEL_PRODUCT_IDS: ReadonlySet<string> = new Set([
  '29207461216',
  '1640186928',
  '19850990926',
  '29231439287',
])

export const MAX_LINES = 6
export const MAX_LINE_QUANTITY = 400
export const MAX_PANELS = 200
export const MAX_URGENCY_NOTE = 200
export const DEFAULT_AMOUNT_CEILING = 50000

/** The comments printed on every Jack quote. Fixed server-side, never taken
 *  from the caller, so no caller text reaches the customer document. */
export const AGENT_QUOTE_COMMENTS: readonly string[] = [
  'Prices in Australian dollars, excluding GST.',
  'Freight is quoted separately.',
]

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Bearer check against AGENT_QUOTE_SECRET or AGENT_QUOTE_SECRET_PREVIOUS (the
 * previous one exists so a rotation needs no downtime). Same shape as
 * /api/mrp/run: sha256 digests compared with timingSafeEqual. Fails CLOSED: an
 * unset or blank secret matches nothing, so with neither set every request is
 * refused.
 */
export function authorizeBearer(
  header: string | null | undefined,
  env: { AGENT_QUOTE_SECRET?: string; AGENT_QUOTE_SECRET_PREVIOUS?: string },
): boolean {
  const got = digest(header ?? '')
  let ok = false
  for (const secret of [env.AGENT_QUOTE_SECRET, env.AGENT_QUOTE_SECRET_PREVIOUS]) {
    if (!secret || secret.trim() === '') continue
    // Evaluate both candidates, no early exit.
    if (timingSafeEqual(digest(`Bearer ${secret}`), got)) ok = true
  }
  return ok
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

const conversationId = z.string().max(128).regex(/^conv_[A-Za-z0-9]+$/)
const dealId = z.string().max(32).regex(/^\d+$/)

const lineSchema = z
  .object({
    productId: z.string().max(32).regex(/^\d+$/),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  })
  .strict()

export type QuotePricing = 'list' | 'urgent'

const createSchema = z
  .object({
    action: z.literal('create'),
    conversationId,
    dealId,
    lines: z.array(lineSchema).min(1).max(MAX_LINES),
    pricing: z.enum(['list', 'urgent']),
    /** What the caller said made the job urgent. Kept for the audit only: it is
     *  never printed on the quote and never emailed. */
    urgencyNote: z.string().min(1).max(MAX_URGENCY_NOTE).optional(),
  })
  .strict()

const markSentSchema = z
  .object({
    action: z.literal('mark_sent'),
    conversationId,
    dealId,
  })
  .strict()

/** Reissue carries NO conversationId on purpose. The lapsed urgent quote on the
 *  deal is the binding, and the caller is the hourly pipeline worker rather
 *  than a live call. */
const reissueSchema = z
  .object({
    action: z.literal('reissue'),
    dealId,
  })
  .strict()

const bodySchema = z.discriminatedUnion('action', [createSchema, markSentSchema, reissueSchema])

export interface AgentQuoteLine {
  productId: string
  quantity: number
}

export type AgentQuoteBody =
  | {
      action: 'create'
      conversationId: string
      dealId: string
      lines: AgentQuoteLine[]
      pricing: QuotePricing
      urgencyNote?: string
    }
  | { action: 'mark_sent'; conversationId: string; dealId: string }
  | { action: 'reissue'; dealId: string }

export type GuardResult<T> = { ok: true; value: T } | { ok: false; code: AgentQuoteCode }

/**
 * Merge lines naming the same product (the caller may expand two fitting kits
 * into two HKNA lines), keeping first-seen order. The per-line quantity limit
 * applies to the merged figure.
 */
export function mergeLines(lines: readonly AgentQuoteLine[]): AgentQuoteLine[] {
  const order: string[] = []
  const qty = new Map<string, number>()
  for (const line of lines) {
    if (!qty.has(line.productId)) order.push(line.productId)
    qty.set(line.productId, (qty.get(line.productId) ?? 0) + line.quantity)
  }
  return order.map((productId) => ({ productId, quantity: qty.get(productId)! }))
}

/**
 * Parse and limit the body. Extra keys anywhere, a malformed id, more than 6
 * lines, a quantity outside 1..400 (after merging) or more than 200 panels in
 * total is BAD_REQUEST. So is an urgent create with no urgencyNote, or a list
 * create that carries one: the note only exists to record why a floor price was
 * offered. The product allowlist is checked separately (PRODUCT_NOT_ALLOWED) so
 * the caller learns which rule it broke.
 */
export function parseAgentQuoteBody(raw: unknown): GuardResult<AgentQuoteBody> {
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' }
  const body = parsed.data
  if (body.action !== 'create') return { ok: true, value: body }

  const note = body.urgencyNote?.trim()
  if (body.pricing === 'urgent' && !note) return { ok: false, code: 'BAD_REQUEST' }
  if (body.pricing === 'list' && body.urgencyNote !== undefined) return { ok: false, code: 'BAD_REQUEST' }

  const lines = mergeLines(body.lines)
  if (lines.some((l) => l.quantity > MAX_LINE_QUANTITY)) return { ok: false, code: 'BAD_REQUEST' }
  const panels = lines
    .filter((l) => ANZ_PANEL_PRODUCT_IDS.has(l.productId))
    .reduce((sum, l) => sum + l.quantity, 0)
  if (panels > MAX_PANELS) return { ok: false, code: 'BAD_REQUEST' }
  return { ok: true, value: { ...body, lines, ...(note ? { urgencyNote: note } : {}) } }
}

/** Every product on the ANZ allowlist. */
export function checkProductsAllowed(lines: readonly AgentQuoteLine[]): AgentQuoteCode | null {
  return lines.every((l) => Object.prototype.hasOwnProperty.call(ANZ_PRODUCT_ALLOWLIST, l.productId))
    ? null
    : 'PRODUCT_NOT_ALLOWED'
}

/** HubSpot must hold the expected SKU for every product. A product whose SKU
 *  changed in the portal is refused rather than quoted under a guess. */
export function checkProductSkus(
  lines: readonly AgentQuoteLine[],
  skuByProductId: Readonly<Record<string, string>>,
): AgentQuoteCode | null {
  for (const line of lines) {
    const expected = ANZ_PRODUCT_ALLOWLIST[line.productId]
    const actual = String(skuByProductId[line.productId] ?? '').trim()
    if (!expected || actual !== expected) return 'PRODUCT_NOT_ALLOWED'
  }
  return null
}

/** Order-independent key for "the same lines", used by the repeat lookup and by
 *  the retry-ownership check. */
export function linesKey(lines: readonly { productId: string; quantity: number }[]): string {
  return mergeLines(lines.map((l) => ({ productId: String(l.productId), quantity: Number(l.quantity) })))
    .map((l) => `${l.productId}x${l.quantity}`)
    .sort()
    .join(',')
}

/** The lines a stored deal_quotes row was built from, as the request shape. */
export function linesFromRow(
  stored: readonly { productId?: unknown; quantity?: unknown }[] | null | undefined,
): AgentQuoteLine[] {
  const out: AgentQuoteLine[] = []
  for (const line of stored ?? []) {
    const productId = String(line?.productId ?? '').trim()
    const quantity = Math.trunc(Number(line?.quantity ?? 0))
    if (productId === '' || !Number.isFinite(quantity) || quantity < 1) continue
    out.push({ productId, quantity })
  }
  return mergeLines(out)
}

// ---------------------------------------------------------------------------
// Deal shape
// ---------------------------------------------------------------------------

export interface DealShape {
  pipeline?: string | null
  dealstage?: string | null
  hubspot_owner_id?: string | null
  deal_currency_code?: string | null
  contactIds: readonly string[]
}

/**
 * The deal Jack may quote: Australia Sales, open, Appointment to Quotation
 * sent, owned by Geoff, AUD, exactly one contact. AUD is required explicitly
 * because createQuote prices a blank currency as USD. The single contact is
 * refused up front because createQuote only checks it after its writes.
 *
 * `stages` narrows the allowed set. A reissue passes Quotation sent only: the
 * customer is holding a lapsed urgent quote on that stage and nowhere else.
 */
export function checkDealShape(
  deal: DealShape,
  stages: readonly string[] = ANZ_QUOTABLE_STAGES,
): AgentQuoteCode | null {
  if (String(deal.pipeline ?? '') !== ANZ_PIPELINE_ID) return 'NOT_ANZ_DEAL'
  const stage = String(deal.dealstage ?? '')
  if (CLOSED_WON_STAGES.includes(stage) || CLOSED_LOST_STAGES.includes(stage)) return 'DEAL_CLOSED'
  if (!stages.includes(stage)) return 'BAD_STAGE'
  if (String(deal.hubspot_owner_id ?? '') !== ANZ_OWNER_ID) return 'WRONG_OWNER'
  const currency = String(deal.deal_currency_code ?? '').trim().toUpperCase()
  if (!currency || !allowedCurrenciesForPipeline(ANZ_PIPELINE_ID).includes(currency)) return 'NOT_AUD'
  if (deal.contactIds.length !== 1) return 'CONTACT_COUNT'
  return null
}

// ---------------------------------------------------------------------------
// Pricing and amount
// ---------------------------------------------------------------------------

/**
 * Every line must be priced from an active LIST row with a positive price. A
 * manual line would quote whatever unit price the caller sent, and a contract
 * line would read a negotiated price to an unverified caller.
 */
export function checkListPriced(lines: readonly Pick<PricedCartLine, 'priceSource' | 'priced'>[]): AgentQuoteCode | null {
  if (lines.length === 0) return 'NO_PRICE'
  for (const line of lines) {
    if (line.priceSource !== 'list') return 'NO_PRICE'
    if (!(Number(line.priced?.listUnitPrice) > 0)) return 'NO_PRICE'
  }
  return null
}

/**
 * The per-unit cash discount that takes each line from its unit price down to
 * its floor price, in line order.
 *
 * Null when ANY line cannot be floored: no floor_price on the row, a floor
 * above the unit price, or a negative floor. The database does not enforce the
 * second of those on the view Jack reads, so it is checked here rather than
 * assumed. A floor equal to the unit price gives 0, which the caller passes as
 * no discount at all rather than as a zero-value one.
 */
export function urgentPerUnitDiscounts(
  lines: readonly Pick<PricedCartLine, 'priced' | 'floorPrice'>[],
): number[] | null {
  if (lines.length === 0) return null
  const out: number[] = []
  for (const line of lines) {
    const unit = roundCents(Number(line.priced?.listUnitPrice))
    const floor = line.floorPrice
    if (floor === null || floor === undefined || !Number.isFinite(Number(floor))) return null
    const floorPrice = roundCents(Number(floor))
    if (floorPrice < 0 || floorPrice > unit) return null
    out.push(roundCents(unit - floorPrice))
  }
  return out
}

/** AGENT_QUOTE_AMOUNT_CEILING, or 50000 when unset or not a positive number. */
export function amountCeiling(raw: string | undefined | null): number {
  const n = Number(String(raw ?? '').trim())
  return String(raw ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_AMOUNT_CEILING
}

export function checkAmountCeiling(total: number, ceiling: number): AgentQuoteCode | null {
  return Number.isFinite(total) && total <= ceiling ? null : 'AMOUNT_CEILING'
}

// ---------------------------------------------------------------------------
// Urgent pricing: the acceptance window and the words that go with it
// ---------------------------------------------------------------------------

/** The quote expires the day after an urgent one is raised. HubSpot's expiry is
 *  a date, so this is the nearest it can express a 24 hour window. */
export const URGENT_EXPIRY_DAYS = 1
export const URGENT_ACCEPT_WINDOW_MS = 24 * 60 * 60 * 1000
export const URGENT_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** One urgent-priced quote per deal per 30 days, and one reissue per urgent
 *  quote. Both counted from PUBLISHED rows, so an attempt that never reached
 *  the customer does not burn the allowance. */
export const URGENT_CAP_PER_DEAL = 1
export const REISSUE_CAP_PER_URGENT = 1

export function acceptByFrom(now: Date): string {
  return new Date(now.getTime() + URGENT_ACCEPT_WINDOW_MS).toISOString()
}

/** True once the acceptance window has closed. A missing or unparseable
 *  accept_by is NOT treated as lapsed: the reissue refuses instead. */
export function hasLapsed(acceptBy: string | null | undefined, now: Date): boolean {
  const t = Date.parse(String(acceptBy ?? ''))
  return Number.isFinite(t) && t <= now.getTime()
}

/**
 * "3:15pm Tuesday 15 September 2026", in Sydney.
 *
 * Assembled from formatToParts rather than format(), for two reasons: the
 * locale's own joining text ("at") is not the wording Dean asked for, and some
 * ICU builds join the time with U+202F, which would put a non-ASCII character
 * on a customer document and in a DKIM-signed email.
 */
export function formatSydneyDeadline(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) throw new Error('formatSydneyDeadline needs a real timestamp')
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(when)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const text = `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()} ${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`
  // Belt and braces: nothing above ASCII leaves this function.
  return text.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function urgentCommentLine(acceptBy: string): string {
  return `Urgent order price, valid until ${formatSydneyDeadline(acceptBy)} Sydney time. After that the standard price applies.`
}

/** The comments block printed on the quote. List pricing gets the two fixed
 *  lines; urgent adds the acceptance deadline underneath them. */
export function quoteComments(pricing: QuotePricing, acceptBy: string | null): string {
  const lines = [...AGENT_QUOTE_COMMENTS]
  if (pricing === 'urgent' && acceptBy) lines.push(urgentCommentLine(acceptBy))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Caps and repeats
// ---------------------------------------------------------------------------

export const CAP_PER_DEAL_7D = 3
export const CAP_PER_DAY = 20
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000
export const BINDING_WINDOW_MS = 24 * 60 * 60 * 1000

/** At most 3 Jack quotes per deal per 7 days and 20 in any 24 hours. */
export function checkCaps(counts: { dealLast7Days: number; allLast24Hours: number }): AgentQuoteCode | null {
  if (counts.dealLast7Days >= CAP_PER_DEAL_7D) return 'CAP_REACHED'
  if (counts.allLast24Hours >= CAP_PER_DAY) return 'CAP_REACHED'
  return null
}

/** At most one urgent-priced quote per deal per 30 days. */
export function checkUrgentCap(urgentLast30Days: number): AgentQuoteCode | null {
  return urgentLast30Days >= URGENT_CAP_PER_DEAL ? 'URGENT_CAP' : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** JACK_USER_ID must be a real uuid: it is interpolated into a PostgREST
 *  filter, so anything else is treated as misconfiguration. */
export function isUuid(value: string | null | undefined): value is string {
  return UUID_RE.test(String(value ?? ''))
}

/**
 * HubSpot's total against the Hub's.
 *
 * Deliberately the SAME expression as the publish tail (quote-publish-tail.ts),
 * so a CREATED and the REPEAT that returns the same row can never disagree
 * about whether the Sender should hold the email. It used to round to cents
 * here and compare floats there, which flipped on an exact one-cent drift.
 */
export function hasAmountMismatch(amount: number | string | null | undefined, hubAmount: number | string | null | undefined): boolean {
  if (amount === null || amount === undefined || hubAmount === null || hubAmount === undefined) return false
  return Math.abs(Number(amount) - Number(hubAmount)) > 0.01
}

/** The reference a quote number was minted from: JA202600123-2 becomes JA202600123. */
export function quoteReferenceOf(quoteNumber: string | null | undefined): string | null {
  const n = String(quoteNumber ?? '').trim()
  return n === '' ? null : n.replace(/-\d+$/, '')
}
