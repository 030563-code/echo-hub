import 'server-only'

/**
 * The HubSpot company a deal is invoiced to, when deals_registry does not say.
 *
 * open-invoice.ts takes the company from deals_registry.hubspot_company_id, and
 * for EURO SALES that column is mostly empty: the one-time backfill of 14 May
 * 2026 wrote the older EURO deals without their company (999 of the 1,105 EURO
 * rows have none), and the sync that has kept their stages current since has
 * not filled it in. On 25 Sep 2026, 74 of the 233 open EURO SALES deals (67 of
 * them Claire's) had a primary company in HubSpot and none in the registry, so
 * their invoices would have opened with no company and no Xero account code.
 *
 * Read from HubSpot here rather than written back into deals_registry: every
 * write to that table fires the live registry webhook in n8n.
 *
 * Fails soft, like the line descriptions: a HubSpot outage leaves the invoice
 * opening exactly as it did before this existed.
 */

import { hubspotFetch } from '@/lib/hubspot-client'

/** HubSpot-defined association type 5: deal to PRIMARY company. */
const DEAL_TO_PRIMARY_COMPANY = 5

export interface DealCompanyAssociation {
  toObjectId: string | number
  associationTypes?: { category?: string; typeId?: number; label?: string | null }[]
}

/**
 * The deal's primary company, else its only company. Several companies and no
 * primary is no answer: guessing which of them gets the invoice is the mistake
 * this must not make.
 */
export function primaryDealCompanyId(rows: readonly DealCompanyAssociation[]): string | null {
  const primary = rows.find((row) =>
    (row.associationTypes ?? []).some(
      (type) => type.category === 'HUBSPOT_DEFINED' && type.typeId === DEAL_TO_PRIMARY_COMPANY,
    ),
  )
  const chosen = primary ?? (rows.length === 1 ? rows[0] : undefined)
  const id = chosen ? String(chosen.toObjectId).replace(/\D/g, '') : ''
  return id === '' ? null : id
}

export async function fetchDealCompanyId(dealId: string): Promise<string | null> {
  try {
    const response = await hubspotFetch(
      `https://api.hubapi.com/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/companies?limit=100`,
    )
    if (!response.ok) {
      // Never log the body: HubSpot echoes the request back on some errors.
      console.error('fetchDealCompanyId failed', response.status)
      return null
    }
    const data = (await response.json()) as { results?: DealCompanyAssociation[] }
    return primaryDealCompanyId(data.results ?? [])
  } catch (err) {
    console.error('fetchDealCompanyId threw', err instanceof Error ? err.message : 'unknown')
    return null
  }
}
