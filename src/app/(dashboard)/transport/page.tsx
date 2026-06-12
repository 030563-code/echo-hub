import { Truck } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { ModulePlaceholder } from '@/components/module-placeholder'

export default async function TransportPage() {
  await requireCapability('transport.view')
  return (
    <ModulePlaceholder
      title="Transport"
      icon={Truck}
      phase="Phase 3"
      description="Shipment tracking — the ERP /shipping board plus the Cargo Partner general-reference → SPOT ID lookup (PO number is the way in). Absorbs the logistics-hub's carrier integration."
    />
  )
}
