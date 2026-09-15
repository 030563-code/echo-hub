import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { currenciesForOrg, orgLabel } from '@/lib/organisations'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
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

  // The organisation being looked at decides the currency, and the currency
  // goes into the query: the USA page is USD prices, the Canada page CAD.
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="List prices" what="prices" />
  const currencies = currenciesForOrg(org)

  const [prices, products] = await Promise.all([getListPrices(currencies), getHubSpotProducts()])
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
          What the quote builder charges a {orgLabel(org)} customer, in {currencies.join(', ')}, when there
          is no contract price.{' '}
          {canEdit
            ? 'A floor is the lowest a discount may take the price.'
            : 'Read only. Ask Dave to change a price.'}
        </p>
      </div>
      <ListPricesClient prices={prices} catalogue={catalogue} canEdit={canEdit} currencies={[...currencies]} />
    </div>
  )
}
