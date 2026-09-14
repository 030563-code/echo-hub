import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HUBSPOT_PIPELINES, CLOSED_WON_STAGES, CLOSED_LOST_STAGES } from '@/lib/hubspot-constants'
import { allowedCurrenciesForPipeline } from '@/lib/pipeline-config'
import type { PricedCartLine } from '@/lib/quote-pricing'

/**
 * Pure guards for POST /api/agent/quote (Bruce, the ANZ AI sales agent).
 *
 * Everything the route decides before it touches HubSpot lives here, so each
 * rule is unit tested without a network: the bearer compare, the strict body,
 * the line limits, the deal shape, the price source and the amount ceiling.
 * The route stays thin and only wires these to the data.
 *
 * Failures are fixed codes and nothing else. The caller (n8n) never gets input
 * echoed back or raw HubSpot or Supabase text.
 */

export type AgentQuoteCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_BOUND'
  | 'CAP_REACHED'
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
  | 'AMOUNT_CEILING'
  | 'TEMPLATE_MISSING'
  | 'NO_BRUCE_QUOTE'
  | 'QUOTE_PUBLISH_FAILED'
  | 'HUBSPOT_ERROR'
  | 'INTERNAL'

export const CODE_STATUS: Record<AgentQuoteCode, number> = {
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  NOT_BOUND: 403,
  CAP_REACHED: 409,
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
  AMOUNT_CEILING: 422,
  TEMPLATE_MISSING: 422,
  NO_BRUCE_QUOTE: 422,
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
export const DEFAULT_AMOUNT_CEILING = 50000

/** The comments printed on every Bruce quote. Fixed server-side, never taken
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

const createSchema = z
  .object({
    action: z.literal('create'),
    conversationId,
    dealId,
    lines: z.array(lineSchema).min(1).max(MAX_LINES),
  })
  .strict()

const markSentSchema = z
  .object({
    action: z.literal('mark_sent'),
    conversationId,
    dealId,
  })
  .strict()

const bodySchema = z.discriminatedUnion('action', [createSchema, markSentSchema])

export interface AgentQuoteLine {
  productId: string
  quantity: number
}

export type AgentQuoteBody =
  | { action: 'create'; conversationId: string; dealId: string; lines: AgentQuoteLine[] }
  | { action: 'mark_sent'; conversationId: string; dealId: string }

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
 * total is BAD_REQUEST. The product allowlist is checked separately
 * (PRODUCT_NOT_ALLOWED) so the caller learns which rule it broke.
 */
export function parseAgentQuoteBody(raw: unknown): GuardResult<AgentQuoteBody> {
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' }
  const body = parsed.data
  if (body.action === 'mark_sent') return { ok: true, value: body }

  const lines = mergeLines(body.lines)
  if (lines.some((l) => l.quantity > MAX_LINE_QUANTITY)) return { ok: false, code: 'BAD_REQUEST' }
  const panels = lines
    .filter((l) => ANZ_PANEL_PRODUCT_IDS.has(l.productId))
    .reduce((sum, l) => sum + l.quantity, 0)
  if (panels > MAX_PANELS) return { ok: false, code: 'BAD_REQUEST' }
  return { ok: true, value: { ...body, lines } }
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

/** Order-independent key for "the same lines", used by the repeat lookup. */
export function linesKey(lines: readonly { productId: string; quantity: number }[]): string {
  return mergeLines(lines.map((l) => ({ productId: String(l.productId), quantity: Number(l.quantity) })))
    .map((l) => `${l.productId}x${l.quantity}`)
    .sort()
    .join(',')
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
 * The deal Bruce may quote: Australia Sales, open, Appointment to Quotation
 * sent, owned by Geoff, AUD, exactly one contact. AUD is required explicitly
 * because createQuote prices a blank currency as USD. The single contact is
 * refused up front because createQuote only checks it after its writes.
 */
export function checkDealShape(deal: DealShape): AgentQuoteCode | null {
  if (String(deal.pipeline ?? '') !== ANZ_PIPELINE_ID) return 'NOT_ANZ_DEAL'
  const stage = String(deal.dealstage ?? '')
  if (CLOSED_WON_STAGES.includes(stage) || CLOSED_LOST_STAGES.includes(stage)) return 'DEAL_CLOSED'
  if (!ANZ_QUOTABLE_STAGES.includes(stage)) return 'BAD_STAGE'
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

/** AGENT_QUOTE_AMOUNT_CEILING, or 50000 when unset or not a positive number. */
export function amountCeiling(raw: string | undefined | null): number {
  const n = Number(String(raw ?? '').trim())
  return String(raw ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_AMOUNT_CEILING
}

export function checkAmountCeiling(total: number, ceiling: number): AgentQuoteCode | null {
  return Number.isFinite(total) && total <= ceiling ? null : 'AMOUNT_CEILING'
}

// ---------------------------------------------------------------------------
// Caps and repeats
// ---------------------------------------------------------------------------

export const CAP_PER_DEAL_7D = 3
export const CAP_PER_DAY = 20
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000
export const BINDING_WINDOW_MS = 24 * 60 * 60 * 1000

/** At most 3 Bruce quotes per deal per 7 days and 20 in any 24 hours. */
export function checkCaps(counts: { dealLast7Days: number; allLast24Hours: number }): AgentQuoteCode | null {
  if (counts.dealLast7Days >= CAP_PER_DEAL_7D) return 'CAP_REACHED'
  if (counts.allLast24Hours >= CAP_PER_DAY) return 'CAP_REACHED'
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** BRUCE_USER_ID must be a real uuid: it is interpolated into a PostgREST
 *  filter, so anything else is treated as misconfiguration. */
export function isUuid(value: string | null | undefined): value is string {
  return UUID_RE.test(String(value ?? ''))
}

export function hasAmountMismatch(amount: number | string | null | undefined, hubAmount: number | string | null | undefined): boolean {
  if (amount === null || amount === undefined || hubAmount === null || hubAmount === undefined) return false
  // In whole cents, so float noise on an exact one-cent drift does not flag it.
  return Math.abs(Math.round(Number(amount) * 100) - Math.round(Number(hubAmount) * 100)) > 1
}

/** The reference a quote number was minted from: BA202600123-2 becomes BA202600123. */
export function quoteReferenceOf(quoteNumber: string | null | undefined): string | null {
  const n = String(quoteNumber ?? '').trim()
  return n === '' ? null : n.replace(/-\d+$/, '')
}
