import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { invoicingProfile, filedStageLabel } from '@/lib/customer-invoice/invoicing-profile'
import { InvoicingNav } from './invoicing-nav'

// Gates the entire /invoicing/* subtree: the customer-invoicing admin desk
// (accepted-quotes queue -> tax -> Xero), for every organisation with an
// invoicing profile. Distinct from the rep-facing /quotes/accepted tab, which
// is scoped to the rep's own deals.
export default async function InvoicingLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireCapability(['invoicing.view', 'invoicing.manage'])
  // The numbering tab is "TaxJar order transaction created" for Dave and
  // "Invoice numbered" for Claire: same step, different engine. The header
  // organisation decides which wording the tabs carry.
  const org = await activeOrganisation(auth)
  const engine = org ? invoicingProfile(org)?.taxEngine : undefined
  return (
    <>
      <InvoicingNav filedLabel={engine ? filedStageLabel(engine) : undefined} />
      {children}
    </>
  )
}
