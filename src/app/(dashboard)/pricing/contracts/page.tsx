import { requireCapability } from '@/lib/authz'
import { getContractPrices, getContractors, getListPrices } from '@/app/actions/pricing/get-pricing'
import { ContractPricesClient } from './contract-prices-client'

export const dynamic = 'force-dynamic'

/**
 * Per-customer contract prices. Dean's words: contractors such as United
 * Rentals and HERMEQ "have specific prices on contract with us. What we need to
 * setup in supabase is a record of these prices."
 *
 * Keyed by the HubSpot company id, so a deal's own associated company resolves
 * its contract price with no name matching and no room for two spellings of
 * United Rentals to disagree.
 */
export default async function ContractPricesPage() {
  const auth = await requireCapability(['pricing.view', 'pricing.manage'])
  const canEdit = auth.capabilities.has('pricing.manage')

  const [contractors, prices, listPrices] = await Promise.all([
    getContractors(),
    getContractPrices(),
    getListPrices(),
  ])

  const skus = Array.from(new Set(listPrices.map((p) => p.sku))).sort()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Contract prices</h1>
        <p className="text-sm text-gray-600 mt-1">
          What a named customer pays. A contract price beats the list price for that company while it
          is in force. {canEdit ? '' : 'Read only. Ask Dave to change a price.'}
        </p>
      </div>
      <ContractPricesClient
        contractors={contractors}
        prices={prices}
        skus={skus}
        canEdit={canEdit}
      />
    </div>
  )
}
