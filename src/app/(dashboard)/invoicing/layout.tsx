import { requireCapability } from '@/lib/authz'
import { InvoicingNav } from './invoicing-nav'

// Gates the entire /invoicing/* subtree: the US customer-invoicing admin desk
// (accepted-quotes queue -> TaxJar -> Xero). Distinct from the rep-facing
// /quotes/accepted tab, which is scoped to the rep's own deals.
export default async function InvoicingLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['invoicing.view', 'invoicing.manage'])
  return (
    <>
      <InvoicingNav />
      {children}
    </>
  )
}
