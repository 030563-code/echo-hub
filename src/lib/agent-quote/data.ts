import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { BINDING_WINDOW_MS, REPEAT_WINDOW_MS, linesKey, type AgentQuoteLine } from '@/lib/agent-quote/guards'

/**
 * The reads /api/agent/quote makes with the service role before and around the
 * Bruce session: the call binding, caps, repeats, foreign quotes, contract
 * customers, and the HubSpot product names. No writes live here.
 *
 * Every Supabase error THROWS (the route maps it to INTERNAL) rather than being
 * read as "no rows", because an unreadable cap or binding must fail closed.
 */

type Admin = ReturnType<typeof createAdminClient>

const DAY_MS = 24 * 60 * 60 * 1000

function sinceIso(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString()
}

function check<T extends { error: { message?: string } | null }>(result: T, what: string): T {
  if (result.error) throw new Error(`agent-quote read failed: ${what}`)
  return result
}

/**
 * The conversation is bound to the deal: Bruce's log_lead call in this
 * conversation created or found exactly this deal within the last 24 hours.
 * Without it, anyone holding the route secret could aim a quote at any deal.
 */
export async function isConversationBound(admin: Admin, conversationId: string, dealId: string, now: Date): Promise<boolean> {
  const res = check(
    await admin
      .from('bruce_tool_calls')
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

/** Bruce quote rows on this deal in 7 days, and across all deals in 24 hours. */
export async function countBruceQuotes(admin: Admin, bruceUserId: string, dealId: string, now: Date) {
  const [deal, all] = await Promise.all([
    admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('created_by_uid', bruceUserId)
      .eq('hubspot_deal_id', dealId)
      .gte('created_at', sinceIso(now, 7 * DAY_MS)),
    admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('created_by_uid', bruceUserId)
      .gte('created_at', sinceIso(now, DAY_MS)),
  ])
  check(deal, 'deal cap')
  check(all, 'day cap')
  return { dealLast7Days: deal.count ?? 0, allLast24Hours: all.count ?? 0 }
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
  line_items: { productId?: string; quantity?: number }[] | null
}

/** A quote Bruce already published on this deal in the last 24 hours with the
 *  same lines, so a retry after a timeout returns it instead of minting REF-2. */
export async function findRepeatQuote(
  admin: Admin,
  bruceUserId: string,
  dealId: string,
  lines: readonly AgentQuoteLine[],
  now: Date,
): Promise<RepeatRow | null> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id, quote_number, quote_link, pdf_link, amount, hub_amount, currency, expires_on, line_items')
      .eq('created_by_uid', bruceUserId)
      .eq('hubspot_deal_id', dealId)
      .eq('status', 'published')
      .gte('created_at', sinceIso(now, REPEAT_WINDOW_MS))
      .order('created_at', { ascending: false })
      .limit(10),
    'repeat',
  )
  const wanted = linesKey(lines)
  for (const row of (res.data ?? []) as RepeatRow[]) {
    const stored = Array.isArray(row.line_items) ? row.line_items : []
    const key = linesKey(stored.map((l) => ({ productId: String(l.productId ?? ''), quantity: Number(l.quantity ?? 0) })))
    if (row.quote_link && key === wanted) return row
  }
  return null
}

/** Any quote on the deal made by someone other than Bruce. Bruce never
 *  replaces a person's quote. */
export async function hasForeignQuote(admin: Admin, bruceUserId: string, dealId: string): Promise<boolean> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('hubspot_deal_id', dealId)
      .or(`created_by_uid.is.null,created_by_uid.neq.${bruceUserId}`),
    'foreign quote',
  )
  return (res.count ?? 0) > 0
}

/** A published quote on the deal made by Bruce, which mark_sent requires. */
export async function hasPublishedBruceQuote(admin: Admin, bruceUserId: string, dealId: string): Promise<boolean> {
  const res = check(
    await admin
      .from('deal_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('hubspot_deal_id', dealId)
      .eq('created_by_uid', bruceUserId)
      .eq('status', 'published'),
    'bruce quote',
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
