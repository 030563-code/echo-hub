import 'server-only'

import { getAuthorizedUser, type AuthzOk } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { hubspotFetch } from '@/lib/hubspot-client'
import { resolveHubSpotOwnerId } from '@/lib/hubspot-owner'
import { ownerLabel, type OwnerIndex } from '@/lib/hubspot-owners'
import { orgLabel, pipelineForOrg } from '@/lib/organisations'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import type { HubSpotSearchFilter } from '@/lib/deal-filters'
import {
  byCsoOrder,
  closeDay,
  daysPastClose,
  isPastClose,
  pastCloseFilters,
  pastCloseOrgFilters,
} from '@/lib/past-close'

export interface PastCloseDeal {
  id: string
  name: string
  /** The UTC calendar date of the close date, "2026-08-12". */
  closeDay: string
  daysPast: number
  amount: number | null
  currency: string
  /** Whose deal it is. Only on an admin's organisation-wide list; a salesperson's are all theirs. */
  owner?: string
}

export interface PastCloseSummary {
  /** A salesperson's own deals, or every rep's in the organisation an admin is looking at. */
  scope: 'mine' | 'organisation'
  /** The organisation's name ("USA") on an organisation-wide list. */
  organisation?: string
  /** Every open deal past its close date in that scope, as HubSpot counts them. */
  total: number
  /** Largest amount first, then the oldest close date, at most ROWS of them. */
  deals: PastCloseDeal[]
}

/** Rows the banner lists. A longer list says how many more there are. */
const ROWS = 100

/**
 * The open deals past their close date that the person signed in should see, for the Quotes banner.
 *
 * An admin (the people who see "All reps" on the board) gets every open deal in the active
 * organisation's pipeline, whoever owns it. Everyone else, and an admin whose organisation has no
 * pipeline, gets the deals they own in HubSpot, in every pipeline.
 *
 * In the order the CSO's daily list uses (cso-brain/scripts/crm-team-briefs.mjs, the
 * open-past-close-date check): the largest amount first, then the oldest close date, so the Hub
 * and the CSO's email put the same deal at the top. HubSpot's search takes one sort, so it sorts by
 * amount and the tie is broken here.
 *
 * Null means there is nothing to say: no Quotes capability, no HubSpot seat (an admin who sells
 * nothing, the ANZ agent), no token, or the read failed. The banner is a reminder, not the page, so
 * a failed read leaves the page as it was rather than putting an error above it.
 */
export async function pastCloseDealsForViewer(nowMs = Date.now()): Promise<PastCloseSummary | null> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return null
  if (!auth.capabilities.has('quotes.view') && !auth.capabilities.has('quotes.create')) return null

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return null

  const organisationWide = await organisationScope(auth)
  if (organisationWide) {
    return search(pastCloseOrgFilters(organisationWide.pipelineId, nowMs), nowMs, {
      scope: 'organisation',
      organisation: organisationWide.label,
      owners: await getOwnerIndex(),
    })
  }

  const ownerId = await resolveHubSpotOwnerId(auth.user.email ?? '', accessToken)
  if (!ownerId) return null
  return search(pastCloseFilters(ownerId, nowMs), nowMs, { scope: 'mine' })
}

/** The organisation an admin is looking at, when it has a pipeline; null for everyone else. */
async function organisationScope(auth: AuthzOk): Promise<{ pipelineId: string; label: string } | null> {
  // The same test the board uses to offer "All reps".
  const isAdmin = auth.profile.is_super_admin === true || auth.capabilities.has('admin')
  if (!isAdmin) return null
  const org = await activeOrganisation(auth)
  const pipelineId = org ? pipelineForOrg(org) : null
  return org && pipelineId ? { pipelineId, label: orgLabel(org) } : null
}

async function search(
  filters: HubSpotSearchFilter[],
  nowMs: number,
  view: { scope: 'mine' } | { scope: 'organisation'; organisation: string; owners: OwnerIndex },
): Promise<PastCloseSummary | null> {
  try {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: ['dealname', 'closedate', 'amount', 'deal_currency_code', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }],
        limit: ROWS,
      }),
    })
    if (!response.ok) {
      console.error('past close search failed', response.status, await response.text().catch(() => ''))
      return null
    }
    const data = (await response.json()) as {
      total?: number
      results?: { id: string; properties: Record<string, string | null | undefined> }[]
    }

    const deals: PastCloseDeal[] = []
    for (const row of data.results ?? []) {
      const p = row.properties ?? {}
      // The search is the rule, and the rule is applied again here, so a row HubSpot returned for
      // any other reason never reaches the banner.
      if (!isPastClose(p.closedate, nowMs)) continue
      const amount = p.amount == null || String(p.amount).trim() === '' ? null : Number(p.amount)
      const ownerId = String(p.hubspot_owner_id ?? '').trim()
      deals.push({
        id: String(row.id),
        name: String(p.dealname ?? '').trim() || 'Untitled deal',
        closeDay: closeDay(p.closedate)!,
        daysPast: daysPastClose(p.closedate, nowMs)!,
        amount: amount !== null && Number.isFinite(amount) ? amount : null,
        currency: String(p.deal_currency_code ?? '').trim().toUpperCase() || 'USD',
        ...(view.scope === 'organisation'
          ? { owner: ownerId ? ownerLabel(view.owners, ownerId) : 'No owner' }
          : {}),
      })
    }
    deals.sort(byCsoOrder)
    return {
      scope: view.scope,
      ...(view.scope === 'organisation' ? { organisation: view.organisation } : {}),
      total: Math.max(data.total ?? 0, deals.length),
      deals,
    }
  } catch (error) {
    console.error('past close search failed', error)
    return null
  }
}
