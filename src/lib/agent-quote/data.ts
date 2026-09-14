import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  BINDING_WINDOW_MS,
  REPEAT_WINDOW_MS,
  URGENT_CAP_WINDOW_MS,
  linesKey,
  type AgentQuoteLine,
  type QuotePricing,
} from '@/lib/agent-quote/guards'

/**
 * The reads /api/agent/quote makes with the service role before and around the
 * Jack session: the call binding, caps, repeats, in-flight rows, foreign
 * quotes, contract customers, the urgent quote a reissue resumes, and the
 * HubSpot product names.
 *
 * No writes live here. The pricing mode and acceptance deadline are written by
 * runQuotePipeline as part of the row it already inserts, not stamped on
 * afterwards, so a quote can never exist without them.
 *
 * Every Supabase error THROWS (the route maps it to INTERNAL) rather than being
 * read as "no rows", because an unreadable cap or binding must fail closed.
 */

type Admin = ReturnType<typeof createAdminClient>

const DAY_MS = 24 * 60 * 60 * 1000

/** The statuses that mean "a generate or an edit is running on this deal right
 *  now". Same set as the live partial index deal_quotes_one_in_flight. */
const IN_FLIGHT_STATUSES = ['draft', 'editing'] as const

function sinceIso(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString()
}

function check<T extends { error: { message?: string } | null }>(result: T, what: string): T {
  if (result.error) throw new Error(`agent-quote read failed: ${what}`)
  return result
}

/**
 * The conversation is bound to the deal: Jack's log_lead call in this
 * conversation created or found exactly this deal within the last 24 hours.
 * Without it, anyone holding the route secret could aim a quote at any deal.
 */
export async function isConversationBound(admin: Admin, conversationId: string, dealId: string, now: Date): Promise<boolean> {
  const res = check(
    await admin
      .from('jack_tool_calls')
      .select('id')
      .eq('tool', 'log_lead')
      .eq('conversation_id', conversationId)
      .eq('response->>deal_id', dealId)
      .gte('created_at', sinceIso(now, BINDING_WINDOW_MS))
      .limit(1),
    'binding',
  )
  return (res.data ?? []).length > 0
}

/** Jack quote rows on this deal in 7 days, and across all deals in 24 hours. */
export async function countJackQuotes(admin: Admin, jackUserId: string, dealId: string, now: Date) {
  const [deal, all] = await Promise.all([
    admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('created_by_uid', jackUserId)
      .eq('hubspot_deal_id', dealId)
      .gte('created_at', sinceIso(now, 7 * DAY_MS)),
    admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('created_by_uid', jackUserId)
      .gte('created_at', sinceIso(now, DAY_MS)),
  ])
  check(deal, 'deal cap')
  check(all, 'day cap')
  return { dealLast7Days: deal.count ?? 0, allLast24Hours: all.count ?? 0 }
}

/**
 * Published urgent-priced Jack quotes on this deal in the last 30 days.
 *
 * PUBLISHED only: a generate that failed before the customer had a link must
 * not burn the one urgent quote this deal is allowed in a month.
 */
export async function countUrgentQuotes(admin: Admin, jackUserId: string, dealId: string, now: Date): Promise<number> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('created_by_uid', jackUserId)
      .eq('hubspot_deal_id', dealId)
      .eq('pricing_mode', 'urgent')
      .eq('status', 'published')
      .gte('created_at', sinceIso(now, URGENT_CAP_WINDOW_MS)),
    'urgent cap',
  )
  return res.count ?? 0
}

/**
 * A generate or an edit already running on this deal.
 *
 * Checked BEFORE createQuote, because createQuote replaces the deal's line
 * items and amount before runQuotePipeline reaches the one-in-flight index. By
 * the time the 23505 comes back the deal has already been rewritten under the
 * other request. Anyone's row counts, not just Jack's: a rep mid-edit owns the
 * deal as much as a second Quote Sender does.
 */
export async function hasInFlightQuote(admin: Admin, dealId: string): Promise<boolean> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('hubspot_deal_id', dealId)
      .in('status', [...IN_FLIGHT_STATUSES]),
    'in flight',
  )
  return (res.count ?? 0) > 0
}

export interface RepeatRow {
  id: string
  quote_number: string | null
  quote_link: string | null
  pdf_link: string | null
  amount: number | string | null
  hub_amount: number | string | null
  currency: string | null
  expires_on: string | null
  pricing_mode: string | null
  accept_by: string | null
  line_items: { productId?: string; quantity?: number }[] | null
}

const REPEAT_COLUMNS =
  'id, quote_number, quote_link, pdf_link, amount, hub_amount, currency, expires_on, pricing_mode, accept_by, line_items'

/**
 * A quote Jack already published on this deal in the last 24 hours with the
 * same lines AND the same pricing, so a retry after a timeout returns it
 * instead of minting REF-2.
 *
 * Pricing is part of the match on purpose. A list quote and an urgent one for
 * the same cart are different offers at different money, and handing back the
 * list one for an urgent request would quote the customer a price Jack never
 * spoke. A row written before the pricing column existed reads as list.
 */
export async function findRepeatQuote(
  admin: Admin,
  jackUserId: string,
  dealId: string,
  lines: readonly AgentQuoteLine[],
  pricing: QuotePricing,
  now: Date,
): Promise<RepeatRow | null> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select(REPEAT_COLUMNS)
      .eq('created_by_uid', jackUserId)
      .eq('hubspot_deal_id', dealId)
      .eq('status', 'published')
      .gte('created_at', sinceIso(now, REPEAT_WINDOW_MS))
      .order('created_at', { ascending: false })
      .limit(10),
    'repeat',
  )
  const wanted = linesKey(lines)
  for (const row of (res.data ?? []) as RepeatRow[]) {
    if ((row.pricing_mode ?? 'list') !== pricing) continue
    const stored = Array.isArray(row.line_items) ? row.line_items : []
    const key = linesKey(stored.map((l) => ({ productId: String(l.productId ?? ''), quantity: Number(l.quantity ?? 0) })))
    if (row.quote_link && key === wanted) return row
  }
  return null
}

export interface LatestJackQuote extends RepeatRow {
  status: string | null
  reissue_of: string | null
  created_at: string
}

/**
 * The newest quote row Jack owns on this deal, whatever its status.
 *
 * The reissue path reads exactly this one row. A reissue lands as a NEWER row
 * carrying reissue_of, so "the newest Jack row is urgent" already means no
 * reissue has been made, and "the newest Jack row carries reissue_of" is the
 * already-reissued case. One read answers both.
 */
export async function findLatestJackQuote(admin: Admin, jackUserId: string, dealId: string): Promise<LatestJackQuote | null> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select(`${REPEAT_COLUMNS}, status, reissue_of, created_at`)
      .eq('created_by_uid', jackUserId)
      .eq('hubspot_deal_id', dealId)
      .order('created_at', { ascending: false })
      .limit(1),
    'latest jack quote',
  )
  const rows = (res.data ?? []) as LatestJackQuote[]
  return rows[0] ?? null
}

export interface ResumableRow {
  id: string
  created_by_uid: string | null
  created_at: string
  status: string | null
  line_items: { productId?: string; quantity?: number }[] | null
}

/**
 * The row retryHubSpotQuote WOULD pick up: the newest draft or failed row on
 * the deal.
 *
 * The route reads it first and refuses to retry unless it is Jack's own row,
 * created after this request started, holding exactly the lines this request
 * asked for. retryHubSpotQuote itself filters on none of that, so without this
 * a retry can finish a different request's quote and report it as this one.
 */
export async function findResumableQuote(admin: Admin, dealId: string): Promise<ResumableRow | null> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id, created_by_uid, created_at, status, line_items')
      .eq('hubspot_deal_id', dealId)
      .in('status', ['draft', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1),
    'resumable',
  )
  const rows = (res.data ?? []) as ResumableRow[]
  return rows[0] ?? null
}

/** Any quote on the deal made by someone other than Jack. Jack never
 *  replaces a person's quote. */
export async function hasForeignQuote(admin: Admin, jackUserId: string, dealId: string): Promise<boolean> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('hubspot_deal_id', dealId)
      .or(`created_by_uid.is.null,created_by_uid.neq.${jackUserId}`),
    'foreign quote',
  )
  return (res.count ?? 0) > 0
}

/** A published quote on the deal made by Jack, which mark_sent requires. The
 *  link has to be there: a row published with no link is a quote the customer
 *  cannot open, and marking the deal sent would say otherwise. */
export async function hasPublishedJackQuote(admin: Admin, jackUserId: string, dealId: string): Promise<boolean> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('hubspot_deal_id', dealId)
      .eq('created_by_uid', jackUserId)
      .eq('status', 'published')
      .not('quote_link', 'is', null),
    'jack quote',
  )
  return (res.count ?? 0) > 0
}

/** An associated company with active contract prices. Those prices are never
 *  quoted to an unverified caller; a person handles the deal. */
export async function hasActiveContractPrices(admin: Admin, companyIds: readonly string[]): Promise<boolean> {
  if (companyIds.length === 0) return false
  const res = check(
    await admin
      .from('contract_prices')
      .select('hubspot_company_id', { count: 'exact', head: true })
      .in('hubspot_company_id', [...companyIds])
      .eq('is_active', true),
    'contract prices',
  )
  return (res.count ?? 0) > 0
}

/**
 * Name and SKU for each product, straight from HubSpot. The name prints on the
 * customer's quote, the SKU decides the price. A POST to /batch/read is a READ,
 * so it runs in staging too. Null on any failure.
 */
export async function readHubSpotProducts(
  productIds: readonly string[],
): Promise<Record<string, { sku: string; name: string }> | null> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN
  if (!token || productIds.length === 0) return null
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/products/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: ['hs_sku', 'name'], inputs: productIds.map((id) => ({ id })) }),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const body = (await res.json()) as { results?: { id: string; properties?: { hs_sku?: string; name?: string } }[] }
    const out: Record<string, { sku: string; name: string }> = {}
    for (const p of body.results ?? []) {
      const sku = String(p.properties?.hs_sku ?? '').trim()
      const name = String(p.properties?.name ?? '').trim()
      if (p.id && sku && name) out[p.id] = { sku, name }
    }
    return out
  } catch {
    return null
  }
}
