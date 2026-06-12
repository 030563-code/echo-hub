import { requireCapability } from '@/lib/authz'

// Gates the Purchase Orders module (viewer) + dark board surface. Any of the PO
// capabilities grants the board view; create/approve remain with the n8n PO flow.
export default async function PurchaseOrdersLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['po.view', 'po.create', 'po.approve'])
  return (
    <div className="-m-8 min-h-[calc(100vh-65px)] bg-[#111] text-[#e5e5e5]">{children}</div>
  )
}
