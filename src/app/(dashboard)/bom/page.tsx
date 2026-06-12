import { Layers } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { ModulePlaceholder } from '@/components/module-placeholder'

export default async function BomPage() {
  await requireCapability('bom.view')
  return (
    <ModulePlaceholder
      title="Bill of Materials"
      icon={Layers}
      phase="Phase 3"
      description="Manufacturing cost breakdown per assembled SKU, plus the input-cost (e.g. PVC) price-monitoring dashboard. Reads the mfg project's bom_weekly_snapshot and landed-cost data."
    />
  )
}
