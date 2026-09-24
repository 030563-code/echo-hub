import type { CapabilityKey } from '@/lib/capabilities'
import { legsForDestination, type InvoiceLeg } from '@/lib/invoice-legs'
import { orgForDepot, type OrgCode } from '@/lib/organisations'
import { entityPoCurrency, type Currency } from '@/lib/po-currency'

/**
 * Who may see and change what a shipment cost to land.
 *
 * Not everybody who can open Transport: the landed cost is the depot's own books (Group's prices,
 * the duty it paid, the unit cost its stock goes in at). So it takes cost.view as well, and the
 * shipment's own organisation, or Group, which sells every container to the depots. s.r.o. sees
 * every container move but not what the depot paid to land it.
 */
export function landedCostAllowed(
  who: { capabilities: ReadonlySet<CapabilityKey>; organisations: readonly OrgCode[] },
  depot: string | null | undefined,
): boolean {
  if (!who.capabilities.has('transport.view') || !who.capabilities.has('cost.view')) return false
  if (who.organisations.includes('EB-GROUP')) return true
  const owner = orgForDepot(depot)
  return Boolean(owner && who.organisations.includes(owner))
}

/** The currency a depot's books are kept in, which is what its landed cost is worked in. */
export function landedCurrency(depot: string | null | undefined): Currency {
  return entityPoCurrency(depot)
}

/**
 * The leg a depot's goods are sold to it on, Group to USA or Group to Canada, whose HS codes its
 * customs entry is made under. Null for a depot Group does not sell to that way, or no depot.
 */
export function landedLeg(depot: string | null | undefined): InvoiceLeg | null {
  const code = String(depot ?? '').trim().toUpperCase()
  if (!code) return null
  return legsForDestination([code]).find((leg) => leg !== 'SRO_TO_GROUP') ?? null
}
