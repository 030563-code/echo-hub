import { FileText } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { ModulePlaceholder } from '@/components/module-placeholder'

export default async function QuotesPage() {
  await requireCapability(['quotes.view', 'quotes.create'])
  return (
    <ModulePlaceholder
      title="Quotes"
      icon={FileText}
      phase="Phase 2 — Priority 1"
      description="The quote-creation flow, built around the mandatory probability-of-close field that feeds stock, manufacturing, and forecasting. Ported from the sales-hub and wired to deals_registry. First module to go live (for Jillian)."
    />
  )
}
