import { requireCapability } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHubSpotProducts } from '@/app/actions/hubspot/getProducts'
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

  const [contractors, prices, listPrices, catalogue] = await Promise.all([
    getContractors(),
    getContractPrices(),
    getListPrices(),
    getHubSpotProducts(),
  ])

  const skus = Array.from(new Set(listPrices.map((p) => p.sku))).sort()

  // SKU to product name, resolved from the list prices this page already loads
  // rather than copied onto every contract row. One source, so a rename in
  // HubSpot flows through on the next load instead of leaving 68 stale copies.
  const productNames: Record<string, string> = {}
  for (const p of listPrices) {
    if (p.product_name && !productNames[p.sku]) productNames[p.sku] = p.product_name
  }
  // Then HubSpot, for the SKUs that are on no general price list at all. Herc's
  // own logo H10 (EBH10HERC) is the case that forced this: only Herc buys it,
  // so it has a contract price and no list price, and the column showed a bare
  // SKU where every other row showed a product.
  for (const p of catalogue.data ?? []) {
    const sku = String(p.properties.hs_sku ?? '').trim()
    const name = String(p.properties.name ?? '').trim()
    if (sku && name && !productNames[sku]) productNames[sku] = name
  }

  // A CAD contract price on a company with no Canada Xero account code quotes
  // perfectly and then has nowhere to invoice. United Rentals and Herc are both
  // in that state today: they price in CAD on the sheet but have never been run
  // through the Canadian side, so account_registry holds no code for them.
  //
  // ADMIN SIDE ONLY, Dean's call. A rep never sees this: the sales screens show
  // the product, the SKU and the price, and nothing about Xero.
  const canadianCompanies = Array.from(
    new Set(prices.filter((p) => p.currency === 'CAD').map((p) => p.hubspot_company_id)),
  )
  let missingCanadaCodes: string[] = []
  if (canadianCompanies.length > 0) {
    const { data } = await createAdminClient()
      .from('account_registry')
      .select('hubspot_company_id, hubspot_company_name, canada_xero_account_code')
      .in('hubspot_company_id', canadianCompanies.map((id) => Number(id)).filter(Number.isFinite))
    const named = new Map(
      (data ?? []).map((r) => [String(r.hubspot_company_id), r as { hubspot_company_name: string | null; canada_xero_account_code: string | null }]),
    )
    missingCanadaCodes = canadianCompanies
      .filter((id) => {
        const row = named.get(id)
        return !row || String(row.canada_xero_account_code ?? '').trim() === ''
      })
      .map((id) => contractors.find((c) => c.hubspot_company_id === id)?.name ?? named.get(id)?.hubspot_company_name ?? id)
      .sort()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Contract prices</h1>
        <p className="text-sm text-gray-600 mt-1">
          What a named customer pays. A contract price beats the list price for that company while it
          is in force. {canEdit ? '' : 'Read only. Ask Dave to change a price.'}
        </p>
      </div>
      {missingCanadaCodes.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            {missingCanadaCodes.length === 1 ? 'One contractor prices' : `${missingCanadaCodes.length} contractors price`} in CAD but has no Canada Xero account code
          </p>
          <p className="mt-1 text-sm text-amber-800">
            {missingCanadaCodes.join(', ')}. The prices are live and quote correctly. An invoice raised
            against them in Canada has no Xero contact to bill, so add the code before quoting Canadian work.
          </p>
        </div>
      )}
      <ContractPricesClient
        contractors={contractors}
        prices={prices}
        skus={skus}
        productNames={productNames}
        canEdit={canEdit}
      />
    </div>
  )
}
