import { requireCapability } from '@/lib/authz'

// Gates the Purchase Orders module (viewer). Any of the PO capabilities grants
// the board view; create/approve remain with the n8n PO flow. The module is
// light, like the rest of the Hub, so no wrapper surface is needed.
export default async function PurchaseOrdersLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['po.view', 'po.create', 'po.approve'])
  return <>{children}</>
}
