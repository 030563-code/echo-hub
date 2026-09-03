import { requireCapability } from '@/lib/authz'
import { PricingNav } from './pricing-nav'

/**
 * Gates /pricing/*, the price list Dave owns and Jillian reads.
 *
 * pricing.view is deliberately read-only: Dean asked for "a sales tab on the
 * nav bar for them to see live pricing of everything that they can't change".
 * Every write action re-checks pricing.manage for itself, so this gate only
 * decides what opens.
 */
export default async function PricingLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireCapability(['pricing.view', 'pricing.manage'])
  return (
    <>
      <PricingNav canManage={auth.capabilities.has('pricing.manage')} />
      {children}
    </>
  )
}
