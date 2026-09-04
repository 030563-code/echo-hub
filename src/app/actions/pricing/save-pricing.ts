'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { CURRENCY_NAME } from '@/lib/pipeline-config'
import { logPricingChange, requirePricingManage } from '@/app/actions/pricing/shared'
import type { AuthzOk } from '@/lib/authz'

/**
 * The four pricing writes, all guarded the same way.
 *
 * Pattern, following update-bom.ts: check the capability in TypeScript, parse
 * with zod, read the row BEFORE writing so the audit trail has a before image,
 * write through the service-role client, then log best-effort. The tables carry
 * no write policy, so the capability check here is the only thing standing
 * between a request and a price change; nothing is left to RLS to catch.
 */

export type SaveResult = { success: true } | { success: false; error: string }

const CURRENCIES = Object.keys(CURRENCY_NAME) as [string, ...string[]]

/** A HubSpot record id is always digits. Anything else is a client that has
 *  been edited, not a company. */
const HubSpotId = z.string().trim().regex(/^\d+$/, 'That is not a HubSpot record id')
const Sku = z.string().trim().min(1).max(64).toUpperCase()
const Currency = z.enum(CURRENCIES)
const Money = z.number().nonnegative().max(1_000_000)

async function commit(
  auth: AuthzOk,
  table: 'contractors' | 'list_prices' | 'contract_prices' | 'rep_discount_caps',
  rowKey: string,
  before: unknown,
  row: Record<string, unknown>,
  onConflict: string,
): Promise<SaveResult> {
  const admin = createAdminClient()
  const { error } = await admin.from(table).upsert(
    {
      ...row,
      updated_by_uid: auth.user.id,
      updated_by_label: auth.user.email ?? 'Hub user',
      // Set explicitly. This project has no updated_at trigger convention: the
      // four that exist are on unrelated legacy tables.
      updated_at: new Date().toISOString(),
    },
    { onConflict },
  )
  if (error) {
    console.error(`save ${table} failed`, error.message)
    return { success: false, error: `Failed to save. ${error.message}` }
  }

  await logPricingChange(table, rowKey, before, row, auth)
  revalidatePath('/pricing')
  return { success: true }
}

const ListPriceSchema = z.object({
  sku: Sku,
  currency: Currency,
  product_name: z.string().trim().max(200).nullish(),
  hs_product_id: z.string().trim().max(32).nullish(),
  unit_price: Money,
  // MAP (Advertised), the middle tier of the price sheet. Reference only: the
  // quote builder never applies it, so it has no validation beyond being money.
  map_price: Money.nullish(),
  floor_price: Money.nullish(),
  is_active: z.boolean().default(true),
})

export async function saveListPrice(input: z.input<typeof ListPriceSchema>): Promise<SaveResult> {
  const gate = await requirePricingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = ListPriceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid price' }
  const d = parsed.data

  // Checked here as well as by the column constraint, so the admin gets a
  // sentence rather than a Postgres error string.
  if (d.floor_price != null && d.floor_price > d.unit_price) {
    return { success: false, error: 'The floor cannot be above the list price.' }
  }
  // MAP sits between the two on every sheet. Checked in the same place and the
  // same way, so the admin gets a sentence rather than a constraint violation,
  // but only when it is set: MAP is optional and most rows will not carry one.
  if (d.map_price != null && (d.map_price > d.unit_price || (d.floor_price != null && d.map_price < d.floor_price))) {
    return { success: false, error: 'MAP has to sit between the distributor net floor and the list price.' }
  }

  const admin = createAdminClient()
  const { data: before } = await admin
    .from('list_prices')
    .select('*')
    .eq('sku', d.sku)
    .eq('currency', d.currency)
    .maybeSingle()

  return commit(
    gate.auth,
    'list_prices',
    `${d.sku}/${d.currency}`,
    before,
    {
      sku: d.sku,
      currency: d.currency,
      product_name: d.product_name ?? null,
      hs_product_id: d.hs_product_id ?? null,
      unit_price: d.unit_price,
      map_price: d.map_price ?? null,
      floor_price: d.floor_price ?? null,
      is_active: d.is_active,
    },
    'sku,currency',
  )
}

const ContractorSchema = z.object({
  hubspot_company_id: HubSpotId,
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  is_active: z.boolean().default(true),
})

export async function saveContractor(input: z.input<typeof ContractorSchema>): Promise<SaveResult> {
  const gate = await requirePricingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = ContractorSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid contractor' }
  const d = parsed.data

  const admin = createAdminClient()
  const { data: before } = await admin
    .from('contractors')
    .select('*')
    .eq('hubspot_company_id', d.hubspot_company_id)
    .maybeSingle()

  return commit(
    gate.auth,
    'contractors',
    d.hubspot_company_id,
    before,
    {
      hubspot_company_id: d.hubspot_company_id,
      name: d.name,
      domain: d.domain ?? null,
      notes: d.notes ?? null,
      is_active: d.is_active,
    },
    'hubspot_company_id',
  )
}

const ContractPriceSchema = z.object({
  hubspot_company_id: HubSpotId,
  sku: Sku,
  currency: Currency,
  unit_price: Money,
  valid_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  valid_to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  // The contractor's own code for this product, e.g. Herc "H9G" or United
  // Rentals "ECHOBARRIER H9 GREEN". Display and reconciliation only, never a
  // lookup key, so it is free text and stays editable on an existing row.
  customer_part_number: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  is_active: z.boolean().default(true),
})

export async function saveContractPrice(input: z.input<typeof ContractPriceSchema>): Promise<SaveResult> {
  const gate = await requirePricingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = ContractPriceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid contract price' }
  const d = parsed.data

  if (d.valid_from && d.valid_to && d.valid_to < d.valid_from) {
    return { success: false, error: 'The end date cannot be before the start date.' }
  }

  const admin = createAdminClient()
  // A contract price on a contractor nobody has activated would resolve for no
  // deal, so it is refused rather than stored where it cannot take effect.
  const { data: contractor } = await admin
    .from('contractors')
    .select('is_active')
    .eq('hubspot_company_id', d.hubspot_company_id)
    .maybeSingle()
  if (!contractor) return { success: false, error: 'Add the contractor first, then its prices.' }
  if ((contractor as { is_active: boolean }).is_active === false) {
    return { success: false, error: 'That contractor is switched off. Turn it back on before pricing it.' }
  }

  const beforeQuery = admin
    .from('contract_prices')
    .select('*')
    .eq('hubspot_company_id', d.hubspot_company_id)
    .eq('sku', d.sku)
    .eq('currency', d.currency)
  // PostgREST turns .eq(col, null) into `col=eq.null`, which matches nothing.
  // An open-ended row has to be looked up with IS NULL or its own before-image
  // is invisible and the audit trail reads every edit as a first insert.
  const { data: before } = await (
    d.valid_from ? beforeQuery.eq('valid_from', d.valid_from) : beforeQuery.is('valid_from', null)
  ).maybeSingle()

  return commit(
    gate.auth,
    'contract_prices',
    `${d.hubspot_company_id}/${d.sku}/${d.currency}/${d.valid_from ?? 'open'}`,
    before,
    {
      hubspot_company_id: d.hubspot_company_id,
      sku: d.sku,
      currency: d.currency,
      unit_price: d.unit_price,
      valid_from: d.valid_from ?? null,
      valid_to: d.valid_to ?? null,
      customer_part_number: d.customer_part_number ?? null,
      notes: d.notes ?? null,
      is_active: d.is_active,
    },
    'hubspot_company_id,sku,currency,valid_from',
  )
}

const DiscountCapSchema = z.object({
  user_id: z.string().uuid(),
  max_discount_pct: z.number().min(0).max(100).nullish(),
  max_discount_per_unit: Money.nullish(),
})

export async function saveDiscountCap(input: z.input<typeof DiscountCapSchema>): Promise<SaveResult> {
  const gate = await requirePricingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = DiscountCapSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid cap' }
  const d = parsed.data

  const admin = createAdminClient()
  const { data: target } = await admin
    .from('profiles')
    .select('id, display_name, pipeline_id')
    .eq('id', d.user_id)
    .maybeSingle()
  if (!target) return { success: false, error: 'That user does not have a Hub profile.' }

  // A regional pricing admin sets caps for their own region only. Dave is a
  // super admin so this never bites him, but it means the capability can be
  // handed to a regional manager later without also handing them every rep.
  const row = target as { pipeline_id: string | null; display_name: string | null }
  if (!gate.auth.profile.is_super_admin && !gate.auth.capabilities.has('admin')) {
    if (row.pipeline_id !== gate.auth.profile.pipeline_id) {
      return { success: false, error: 'That rep is in another region.' }
    }
  }

  const { data: before } = await admin
    .from('rep_discount_caps')
    .select('*')
    .eq('user_id', d.user_id)
    .maybeSingle()

  return commit(
    gate.auth,
    'rep_discount_caps',
    row.display_name ?? d.user_id,
    before,
    {
      user_id: d.user_id,
      max_discount_pct: d.max_discount_pct ?? null,
      max_discount_per_unit: d.max_discount_per_unit ?? null,
    },
    'user_id',
  )
}
