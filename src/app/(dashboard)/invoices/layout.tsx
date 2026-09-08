import { requireCapability } from '@/lib/authz'

// Gates the Commercial Invoices module by invoice.view. The module is light,
// like the rest of the Hub. Generation lives in Transport (transport.view +
// invoice.create); this is the list/view of issued invoices (finance can hold
// invoice.view without transport).
export default async function InvoicesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('invoice.view')
  return <>{children}</>
}
