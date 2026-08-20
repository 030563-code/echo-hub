import { getSalesProfileSettings } from '@/app/actions/sales/get-profile-settings'
import { getHubSpotProducts } from '@/app/actions/hubspot/getProducts'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { getContactDetails } from '@/app/actions/hubspot/getContactDetails'
import { getLineItems } from '@/app/actions/hubspot/getLineItems'
import { getMappedSkus } from '@/app/actions/sales/get-mapped-skus'
import { DEPOT_MAPPING } from '@/lib/depot-constants'
import { createServerClient } from '@/lib/supabase/server'
import { requireCapability } from '@/lib/authz'
import CreateQuoteForm from './create-quote-form'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import type { ComponentProps } from 'react'

type FormProps = ComponentProps<typeof CreateQuoteForm>

export default async function CreateQuotePage(props: { params: Promise<{ dealId: string }> }) {
  await requireCapability('quotes.create')
  const params = await props.params;
  const supabase = await createServerClient()
  
  // 1. Fetch User Details
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user?.id)
    .single()

  const salesRep = {
    name: profile?.display_name || user?.email || 'Sales Rep',
    email: user?.email || ''
  }

  // 2. Fetch Deal Details to get Contact ID and Line Items
  const { data: deal } = await getDealDetails(params.dealId)
  const contactId = deal?.associations?.contacts?.results?.[0]?.id
  
  // Handle both potential keys for line items (singular or plural)
  // HubSpot API v3 often uses the object type name, which can be tricky.
  // Based on your n8n output, it might be under 'line items' (with a space) or 'line_items'.
  // The API response object usually normalizes this, but let's be robust.
  const assoc = deal?.associations as Record<string, { results?: { id: string }[] }> | undefined
  const lineItemsAssoc = assoc?.line_items || assoc?.line_item || assoc?.['line items']
  const lineItemIds = lineItemsAssoc?.results?.map((i) => i.id) || []

  // 3. Fetch Contact Details & Line Items
  let contact: FormProps['contact'] = null
  let existingLineItems: FormProps['initialLineItems'] = []

  const promises = []
  if (contactId) promises.push(getContactDetails(contactId))
  if (lineItemIds.length > 0) promises.push(getLineItems(lineItemIds))

  const results = await Promise.all(promises)

  if (contactId) {
    const contactResult = results.shift()
    if (contactResult?.success) contact = (contactResult.data ?? null) as FormProps['contact']
  }

  if (lineItemIds.length > 0) {
    const lineItemsResult = results.shift()
    if (lineItemsResult?.success) existingLineItems = (lineItemsResult.data ?? []) as FormProps['initialLineItems']
  }

  // 4. Fetch Settings first, then Products and Mapped SKUs. The SKU fetch is
  // scoped to the caller's own depots — the previous bare getMappedSkus() sent
  // EVERY mapped code (EB-SRO's manufacturing SKUs included) to the browser.
  // An empty allowed_depots (super-admin profiles) falls back to the full list.
  const settingsResult = await getSalesProfileSettings()
  const settings = settingsResult.data || {
    allowed_distributors: [],
    allowed_depots: [],
    allowed_quote_templates: [],
    is_super_admin: false
  }

  const [productsResult, mappedSkusResult] = await Promise.all([
    getHubSpotProducts(),
    settings.allowed_depots.length > 0 ? getMappedSkus(settings.allowed_depots) : getMappedSkus()
  ])

  const allProducts = productsResult.data || []
  const mappedSkus = mappedSkusResult.data || []

  // Filter products based on mapped SKUs
  const products = allProducts.filter(p => p.properties.hs_sku && mappedSkus.includes(p.properties.hs_sku))

  // The deal may already carry a sending depot (HubSpot stores the internal
  // NAME, e.g. "US Baltimore"); reverse-map it to the code the form works in.
  // A raw code is accepted too, in case the property was ever set directly.
  const depotNameToCode = Object.fromEntries(
    Object.entries(DEPOT_MAPPING).map(([code, name]) => [name, code])
  )
  const rawSendingDepot = (deal?.properties?.sending_depot || '').trim()
  const initialDepot =
    depotNameToCode[rawSendingDepot] ?? (rawSendingDepot in DEPOT_MAPPING ? rawSendingDepot : '')

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href={`/quotes/requests/${params.dealId}`}>
          <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-900">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Deal
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Create New Quote</h1>
      </div>

      <CreateQuoteForm 
        dealId={params.dealId} 
        dealName={deal?.properties?.dealname || ''}
        initialDepot={initialDepot}
        settings={settings} 
        products={products}
        salesRep={salesRep}
        contact={contact}
        initialLineItems={existingLineItems}
      />
    </div>
  )
}
