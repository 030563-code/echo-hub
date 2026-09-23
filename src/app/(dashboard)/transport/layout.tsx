import { requireCapability } from '@/lib/authz'
import { TransportTabs } from './transport-tabs'

// Gates the Transport module. It used to wrap the subtree in the ported ERP
// boards' dark surface; Transport is now light, like the Quotes and Invoicing
// screens people read all day, so the wrapper is gone and the dashboard shell's
// own padding applies. Purchase Orders and MRP keep theirs until they are
// converted too.
//
// The Customs tab (Nippon Express bills) is shown to customs.manage only; the
// page checks it again itself.
export default async function TransportLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireCapability('transport.view')
  return (
    <>
      <TransportTabs showCustoms={auth.capabilities.has('customs.manage')} />
      {children}
    </>
  )
}
