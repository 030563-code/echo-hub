import { requireCapability } from '@/lib/authz'
import { InvoicesNav } from './invoices-nav'

// Gates the Commercial Invoices module by invoice.view. The module is light,
// like the rest of the Hub. Generation lives on /invoices (invoice.create +
// cost.view); the HS codes tab is read with invoice.view and edited with
// invoice.create. Each page and action checks for itself as well.
export default async function InvoicesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('invoice.view')
  return (
    <>
      <InvoicesNav />
      {children}
    </>
  )
}
