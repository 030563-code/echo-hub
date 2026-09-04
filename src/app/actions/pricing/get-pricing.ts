import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import type { ContractPriceRow, DiscountCap, ListPriceRow } from '@/lib/pricing'

/**
 * The reads behind the pricing pages and the quote builder.
 *
 * Page reads go through the SESSION client so the SELECT policies are the
 * enforcer and a rep can never see a cap that is not theirs. The quote
 * builder's own load is the exception and says why below.
 */

export interface ContractorRow {
  hubspot_company_id: string
  name: string
  domain: string | null
  is_active: boolean
  notes: string | null
  updated_by_label: string | null
  updated_at: string
}

export interface ListPriceRecord extends ListPriceRow {
  id: string
  product_name: string | null
  hs_product_id: string | null
  updated_by_label: string | null
  updated_at: string
}

export interface ContractPriceRecord extends ContractPriceRow {
  id: string
  notes: string | null
  updated_by_label: string | null
  updated_at: string
}

export interface DiscountCapRecord extends DiscountCap {
  user_id: string
  updated_by_label: string | null
  updated_at: string
}

export async function getListPrices(): Promise<ListPriceRecord[]> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('list_prices')
    .select('*')
    .order('sku', { ascending: true })
    .order('currency', { ascending: true })
  if (error) {
    console.error('getListPrices failed', error.message)
    return []
  }
  return (data ?? []) as ListPriceRecord[]
}

export async function getContractors(): Promise<ContractorRow[]> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('contractors')
    .select('*')
    // Active first, then alphabetical: a deactivated contractor stays visible
    // so its historic prices can still be explained, but out of the way.
    .order('is_active', { ascending: false })
    .order('name', { ascending: true })
  if (error) {
    console.error('getContractors failed', error.message)
    return []
  }
  return (data ?? []) as ContractorRow[]
}

export async function getContractPrices(): Promise<ContractPriceRecord[]> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('contract_prices')
    .select('*')
    .order('sku', { ascending: true })
  if (error) {
    console.error('getContractPrices failed', error.message)
    return []
  }
  return (data ?? []) as ContractPriceRecord[]
}

/** Every rep's cap, for the admin tab. The SELECT policy already limits this to
 *  the caller's own row unless they hold pricing.manage. */
export async function getDiscountCaps(): Promise<DiscountCapRecord[]> {
  const supabase = await createServerClient()
  const { data, error } = await supabase.from('rep_discount_caps').select('*')
  if (error) {
    console.error('getDiscountCaps failed', error.message)
    return []
  }
  return (data ?? []) as DiscountCapRecord[]
}

export interface QuotePricing {
  listPrices: ListPriceRow[]
  contractPrices: ContractPriceRow[]
  contractorName: string | null
  cap: DiscountCap | null
}

/**
 * Everything the quote builder needs to price a cart, loaded once.
 *
 * This one uses the ADMIN client, and deliberately: the create-quote action has
 * to resolve exactly the same prices the browser was shown, and it must do so
 * from rows the browser cannot influence. Both the page and the server action
 * call this, so the two can never disagree about what the list price was.
 *
 * The caller has already been authorised for the deal (assertDealAccess or
 * requireCapability) before this runs. It returns prices, which are not
 * per-user data, plus exactly one cap row: the caller's own.
 */
export async function loadPricingForQuote(input: {
  companyId: string | null
  currency: string
  userId: string
}): Promise<QuotePricing> {
  const admin = createAdminClient()
  const currency = String(input.currency ?? '').trim().toUpperCase()
  const companyId = String(input.companyId ?? '').trim()

  const [list, contract, cap, contractor] = await Promise.all([
    admin.from('list_prices').select('sku, currency, unit_price, floor_price, is_active').eq('currency', currency).eq('is_active', true),
    companyId
      ? admin
          .from('contract_prices')
          .select('hubspot_company_id, sku, currency, unit_price, valid_from, valid_to, customer_part_number, is_active')
          .eq('hubspot_company_id', companyId)
          .eq('currency', currency)
          .eq('is_active', true)
      : Promise.resolve({ data: [], error: null }),
    admin.from('rep_discount_caps').select('max_discount_pct, max_discount_per_unit').eq('user_id', input.userId).maybeSingle(),
    companyId
      ? admin.from('contractors').select('name, is_active').eq('hubspot_company_id', companyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (list.error) console.error('loadPricingForQuote list_prices failed', list.error.message)
  if (contract.error) console.error('loadPricingForQuote contract_prices failed', contract.error.message)

  const contractorRow = contractor.data as { name?: string; is_active?: boolean } | null
  return {
    listPrices: (list.data ?? []) as ListPriceRow[],
    contractPrices: (contract.data ?? []) as ContractPriceRow[],
    // Only name a contractor the rep can actually be quoting under. A
    // deactivated one would explain a contract price that is no longer applied.
    contractorName: contractorRow?.is_active === true ? (contractorRow.name ?? null) : null,
    cap: (cap.data ?? null) as DiscountCap | null,
  }
}

export interface RepRow {
  id: string
  display_name: string | null
  email: string | null
  pipeline_id: string | null
}

/**
 * The reps a pricing admin may set a cap for.
 *
 * Uses the admin client because profiles is not readable across users by an
 * ordinary session, and the caller has already been checked for pricing.manage
 * by the page. A regional admin sees their own region; a super admin sees
 * everyone, which is how Dave uses it.
 */
export async function getRepsForCaps(input: {
  pipelineId: string | null
  isSuperAdmin: boolean
}): Promise<RepRow[]> {
  const admin = createAdminClient()
  let query = admin
    .from('profiles')
    .select('id, display_name, email, pipeline_id')
    .order('display_name', { ascending: true })
  if (!input.isSuperAdmin) {
    // A null pipeline would match nothing useful, so an unscoped admin sees an
    // empty list and the page says why rather than showing the whole company.
    query = query.eq('pipeline_id', input.pipelineId ?? '__none__')
  }
  const { data, error } = await query
  if (error) {
    console.error('getRepsForCaps failed', error.message)
    return []
  }
  return (data ?? []) as RepRow[]
}
