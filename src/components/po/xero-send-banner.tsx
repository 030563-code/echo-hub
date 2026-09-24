import { getAuthorizedUser } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { chainFilter, chainsForOrg } from '@/lib/po-organisations'
import { createServerClient } from '@/lib/supabase/server'
import { loadXeroSendFailures } from '@/lib/po-xero-send.server'
import XeroSendFailures from './xero-send-failures'

/**
 * The dashboard's line about approved purchase orders that are not in Xero.
 *
 * For po.approve holders only, because they are the ones who can send an order again, and for
 * the organisation they are looking at, because that is the outer scope of everything: the
 * organisation's chains go into the query, the same filter the board and the approvals page use.
 *
 * Rendered inside its own Suspense boundary with no fallback, so the dashboard never waits for
 * it. Renders nothing when nothing has failed.
 */
export async function XeroSendBanner() {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('po.approve')) return null
  const org = await activeOrganisation(auth)
  if (!org) return null
  const supabase = await createServerClient()
  const filter = chainFilter(await chainsForOrg(supabase, org))
  const failures = await loadXeroSendFailures(supabase, filter)
  if (failures.length === 0) return null
  return (
    <div className="mb-8 max-w-3xl">
      <XeroSendFailures failures={failures} compact />
    </div>
  )
}
