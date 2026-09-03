import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthorizedUser, type AuthzOk } from '@/lib/authz'

/**
 * The gate and the audit trail every pricing write goes through.
 *
 * Prices are commercial authority, not just data: what is in list_prices
 * decides what a rep may charge and what floor a discount may not cross. So
 * reads are open to anyone who can quote (a rep must be able to build a quote
 * at list price without being granted anything new), and writes are shut to
 * everyone but pricing.manage, checked here rather than trusted to RLS. The
 * tables carry no write policy at all, so a missed check is a failed write and
 * not a silent one.
 */

export type PricingAuth = { ok: true; auth: AuthzOk } | { ok: false; error: string }

/** Capability gate for every pricing write. pricing.view is read-only and is
 *  only used to open the pages. */
export async function requirePricingManage(): Promise<PricingAuth> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('pricing.manage')) {
    return { ok: false, error: 'Forbidden: needs pricing.manage' }
  }
  return { ok: true, auth }
}

/**
 * Append-only history of who changed a price and to what.
 *
 * Best-effort by design, the bom_edit_log precedent: the edit has already
 * succeeded by the time this runs, and losing an audit row is not a reason to
 * tell the admin their price did not save. Failures are logged loudly enough
 * to notice in the server logs.
 */
export async function logPricingChange(
  tableName: 'contractors' | 'list_prices' | 'contract_prices' | 'rep_discount_caps',
  rowKey: string,
  before: unknown,
  after: unknown,
  auth: AuthzOk,
): Promise<void> {
  try {
    await createAdminClient().from('pricing_change_log').insert({
      table_name: tableName,
      row_key: rowKey,
      before: before ?? null,
      after: after ?? null,
      changed_by_uid: auth.user.id,
      changed_by_label: auth.user.email ?? 'Hub user',
    })
  } catch (e) {
    console.error('pricing_change_log insert failed', e)
  }
}
