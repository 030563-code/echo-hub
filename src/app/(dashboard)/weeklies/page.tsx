import { CalendarCheck } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { ModulePlaceholder } from '@/components/module-placeholder'

export default async function WeekliesPage() {
  await requireCapability('weeklies.view')
  return (
    <ModulePlaceholder
      title="Weeklies"
      icon={CalendarCheck}
      phase="Phase 4"
      description="The Mondays / Tuesdays / Wednesdays operating-cadence tracker, merged in from the existing weekly-tracker build."
    />
  )
}
