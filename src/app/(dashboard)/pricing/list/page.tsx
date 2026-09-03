import { requireCapability } from '@/lib/authz'
import { getListPrices } from '@/app/actions/pricing/get-pricing'
import { getHubSpotProducts } from '@/app/actions/hubspot/getProducts'
import { ListPricesClient } from './list-prices-client'

export const dynamic = 'force-dynamic'

/**
 * The general price list.
 *
 * The HubSpot catalogue is shown beside it on purpose: every USA product still
 * carries a 1.00 placeholder, so seeing that number next to the real one is
 * what tells Dave which SKUs he has covered and which are still guesswork.
 */
export default async function ListPricesPage() {
  const auth = await requireCapability(['pricing.view', 'pricing.manage'])
  const canEdit = auth.capabilities.has('pricing.manage')

  const [prices, products] = await Promise.all([getListPrices(), getHubSpotProducts()])
  const catalogue = (products.data ?? [])
    .filter((p) => p.properties.hs_sku)
    .map((p) => ({
      sku: String(p.properties.hs_sku),
      name: p.properties.name,
      hsProductId: p.id,
      hubspotPrice: p.properties.price,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">List prices</h1>
        <p className="text-sm text-gray-600 mt-1">
          What the quote builder charges when a customer has no contract price.{' '}
          {canEdit
            ? 'A floor is the lowest a discount may take the price.'
            : 'Read only. Ask Dave to change a price.'}
        </p>
      </div>
      <ListPricesClient prices={prices} catalogue={catalogue} canEdit={canEdit} />
    </div>
  )
}
