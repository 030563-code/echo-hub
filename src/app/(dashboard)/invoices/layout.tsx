import { requireCapability } from '@/lib/authz'

// Gates the Commercial Invoices module by invoice.view + the dark board surface.
// Generation lives in Transport (transport.view + invoice.create); this is the
// list/view of issued invoices (finance can hold invoice.view without transport).
export default async function InvoicesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('invoice.view')
  return (
    <div className="-m-8 min-h-[calc(100vh-65px)] bg-[#111] text-[#e5e5e5]">{children}</div>
  )
}
