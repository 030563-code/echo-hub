import { requireCapability } from '@/lib/authz'

// Gates the Transport module. It used to wrap the subtree in the ported ERP
// boards' dark surface; Transport is now light, like the Quotes and Invoicing
// screens people read all day, so the wrapper is gone and the dashboard shell's
// own padding applies. Purchase Orders and MRP keep theirs until they are
// converted too.
export default async function TransportLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('transport.view')
  return <>{children}</>
}
