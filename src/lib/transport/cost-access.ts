import type { CapabilityKey } from '@/lib/capabilities'
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
