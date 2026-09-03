import { requireCapability } from '@/lib/authz'
import { getDiscountCaps, getRepsForCaps } from '@/app/actions/pricing/get-pricing'
import { PIPELINE_CONFIG } from '@/lib/pipeline-config'
import { DiscountCapsClient } from './discount-caps-client'

export const dynamic = 'force-dynamic'

/**
 * How far each rep may discount. Dean's words: "Sales people are allowed to do
 * discounts up to a certain percentage and unit price, the admin dave sets the
 * discounts capability in his admin tab."
 *
 * pricing.manage only, and the nav hides the tab from a read-only viewer, but
 * this gate is the one that matters.
 */
export default async function DiscountCapsPage() {
  const auth = await requireCapability('pricing.manage')
  const isSuperAdmin = auth.profile.is_super_admin || auth.capabilities.has('admin')

  const [caps, reps] = await Promise.all([
    getDiscountCaps(),
    getRepsForCaps({ pipelineId: auth.profile.pipeline_id, isSuperAdmin }),
  ])

  const pipelineLabel = (id: string | null) =>
    PIPELINE_CONFIG.find((p) => p.pipelineId === id)?.label ?? (id ? 'Other region' : 'No region')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Discount caps</h1>
        <p className="text-sm text-gray-600 mt-1">
          A rep with no cap cannot discount at all. Set either limit, or both, and every one you set
          has to hold. A SKU floor still applies on top.
        </p>
      </div>
      <DiscountCapsClient
        reps={reps.map((r) => ({ ...r, pipelineLabel: pipelineLabel(r.pipeline_id) }))}
        caps={caps}
      />
    </div>
  )
}
