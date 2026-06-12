import { ShoppingCart } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { ModulePlaceholder } from '@/components/module-placeholder'

export default async function PurchaseOrdersPage() {
  await requireCapability(['po.view', 'po.create', 'po.approve'])
  return (
    <ModulePlaceholder
      title="Purchase Orders"
      icon={ShoppingCart}
      phase="Phase 3"
      description="The intercompany PO lifecycle — raise (po.create), view (po.view), and approve (po.approve) are distinct capabilities, so a user like Jillian can raise a PO without being able to authorise one."
    />
  )
}
