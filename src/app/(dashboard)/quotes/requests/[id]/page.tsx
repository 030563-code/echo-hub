import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { createServerClient } from '@/lib/supabase/server'
import { getCompanyDetails } from '@/app/actions/hubspot/getCompanyDetails'
import { getContactDetails } from '@/app/actions/hubspot/getContactDetails'
import { getLineItems } from '@/app/actions/hubspot/getLineItems'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Calendar, FileText, Building, User, Phone, MapPin, Mail, Briefcase, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { QUOTE_REQUEST_STAGES } from '@/lib/hubspot-constants'
import ChangeStageDialog from '@/components/change-stage-dialog'

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const formatMoney = (value: unknown) => currencyFormatter.format(Number(value) || 0)

const formatDate = (value: unknown) => {
  if (value == null || value === '') return '-'
  const date = new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString()
}

interface HubSpotAssociationResult {
  id: string
}

interface HubSpotAssociationGroup {
  results?: HubSpotAssociationResult[]
}

interface HubSpotCompany {
  properties: {
    name?: string
    domain?: string
    city?: string
    state?: string
  }
}

interface HubSpotContact {
  properties: {
    firstname?: string
    lastname?: string
    jobtitle?: string
    email?: string
    phone?: string
  }
}

interface HubSpotLineItem {
  id: string
  properties: {
    name?: string
    quantity?: string
    price?: string
    amount?: string
  }
}

export default async function QuoteRequestDetailsPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { success, data: deal, error } = await getDealDetails(params.id)

  if (!success || !deal) {
    if (error === 'Deal not found') {
      notFound()
    }
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-red-600">Error Loading Deal</h2>
        <p className="text-gray-500 mt-2">{error}</p>
        <Link href="/quotes/requests" className="mt-4 inline-block">
          <Button variant="outline">Back to Requests</Button>
        </Link>
      </div>
    )
  }

  // Fetch Associated Company, Contact, and Line Items
  const companyId = deal.associations?.companies?.results?.[0]?.id
  const contactId = deal.associations?.contacts?.results?.[0]?.id
  const associations = (deal.associations ?? {}) as Record<string, HubSpotAssociationGroup | undefined>
  const lineItemsAssoc = associations.line_items || associations.line_item || associations['line items']
  const lineItemIds = lineItemsAssoc?.results?.map((i) => i.id) || []

  const supabase = await createServerClient()
  const { data: registryEntry } = await supabase
    .from('deals_registry')
    .select('deal_probability')
    .eq('hubspot_deal_id', params.id)
    .maybeSingle()
  const dealProbability: number | null = registryEntry?.deal_probability ?? null

  const promises = []
  if (companyId) promises.push(getCompanyDetails(companyId))
  if (contactId) promises.push(getContactDetails(contactId))
  if (lineItemIds.length > 0) promises.push(getLineItems(lineItemIds))

  const results = await Promise.all(promises)
  
  let company: HubSpotCompany | null = null
  let contact: HubSpotContact | null = null
  let lineItems: HubSpotLineItem[] = []

  if (companyId) {
    const res = results.shift()
    if (res?.success) company = res.data as HubSpotCompany
  }
  if (contactId) {
    const res = results.shift()
    if (res?.success) contact = res.data as HubSpotContact
  }
  if (lineItemIds.length > 0) {
    const res = results.shift()
    if (res?.success) lineItems = (res.data as HubSpotLineItem[]) || []
  }

  const isQuoteRequest = QUOTE_REQUEST_STAGES.includes(deal.properties.dealstage)

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header Navigation */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/quotes/requests">
          <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-900">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Requests
          </Button>
        </Link>
      </div>

      {/* Main Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{deal.properties.dealname || 'Untitled Deal'}</h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
            <span className="flex items-center gap-1">
              <Calendar className="w-4 h-4" />
              Created: {formatDate(deal.properties.createdate)}
            </span>
            <span className="flex items-center gap-1">
              <FileText className="w-4 h-4" />
              ID: {deal.id}
            </span>
          </div>
        </div>
        <div className="flex gap-3">
           <ChangeStageDialog 
             dealId={deal.id} 
             currentStageId={deal.properties.dealstage} 
             pipelineId={deal.properties.pipeline} 
           />
           {process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID && (
             <a
               href={`https://app.hubspot.com/contacts/${process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID}/deal/${deal.id}`}
               target="_blank"
               rel="noopener noreferrer"
             >
               <Button variant="outline" className="border-gray-300">
                 Edit in HubSpot
               </Button>
             </a>
           )}
           {isQuoteRequest && (
             <Link href={`/quotes/create/${deal.id}`}>
               <Button className="bg-echo-yellow text-black hover:bg-echo-yellow/90">
                 Generate Quote
               </Button>
             </Link>
           )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Deal Info & Line Items */}
        <div className="md:col-span-2 space-y-6">
          <Card className="p-6 bg-white border-gray-200">
            <h3 className="text-lg font-semibold mb-4 border-b border-gray-100 pb-2 text-gray-900">Deal Information</h3>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="text-xs uppercase text-gray-500 font-bold">Amount</label>
                <div className="flex items-center gap-2 mt-1 text-xl font-mono font-medium text-gray-900">
                  {deal.properties.amount ? formatMoney(deal.properties.amount) : 'N/A'}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase text-gray-500 font-bold">Deal Probability</label>
                <div className="mt-1 text-xl font-mono font-medium text-gray-900">
                  {dealProbability != null ? `${dealProbability}%` : 'N/A'}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase text-gray-500 font-bold">Stage</label>
                <div className="mt-1">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 border border-yellow-200">
                    {/* Ideally map stage ID to label */}
                    {isQuoteRequest ? 'Quote Request' : 'Other Stage'}
                  </span>
                </div>
              </div>
              <div className="col-span-2">
                <label className="text-xs uppercase text-gray-500 font-bold">Description</label>
                <p className="mt-1 text-gray-700 whitespace-pre-wrap">
                  {deal.properties.description || 'No description provided.'}
                </p>
              </div>
            </div>
          </Card>

          {/* Line Items Card */}
          <Card className="p-6 bg-white border-gray-200">
            <div className="flex items-center gap-2 mb-4 border-b border-gray-100 pb-2">
              <ShoppingCart className="w-5 h-5 text-gray-500" />
              <h3 className="text-lg font-semibold text-gray-900">Line Items</h3>
            </div>
            
            {lineItems.length > 0 ? (
              <div className="space-y-4">
                {lineItems.map((item) => (
                  <div key={item.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
                    <div>
                      <p className="font-medium text-gray-900">{item.properties.name || 'Unnamed item'}</p>
                      <p className="text-xs text-gray-500">Qty: {item.properties.quantity || '0'}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-medium text-gray-900">
                        {formatMoney(item.properties.amount)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatMoney(item.properties.price)} / unit
                      </p>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between items-center pt-4 border-t border-gray-100">
                  <span className="font-bold text-gray-700">Total</span>
                  <span className="font-bold text-xl text-gray-900">
                    {formatMoney(lineItems.reduce((sum, item) => sum + (Number(item.properties.amount) || 0), 0))}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic">No line items associated with this deal.</p>
            )}
          </Card>
        </div>

        {/* Right Column: Associations */}
        <div className="space-y-6">
          <Card className="p-6 bg-white border-gray-200">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-4">Associations</h3>
            
            <div className="space-y-6">
              {/* Company Details */}
              <div>
                <div className="flex items-center gap-2 mb-2 text-gray-900 font-medium">
                  <Building className="w-4 h-4 text-gray-500" />
                  <span>Company</span>
                </div>
                {company ? (
                  <div className="text-sm text-gray-600 pl-6 space-y-1">
                    <p className="font-semibold text-gray-900">{company.properties.name || 'Unknown company'}</p>
                    {company.properties.domain && (
                      <p className="text-blue-600 hover:underline truncate">{company.properties.domain}</p>
                    )}
                    {(company.properties.city || company.properties.state) && (
                      <div className="flex items-center gap-1 text-gray-500">
                        <MapPin className="w-3 h-3" />
                        <span>
                          {[company.properties.city, company.properties.state].filter(Boolean).join(', ')}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 pl-6 italic">No company associated</p>
                )}
              </div>

              <div className="border-t border-gray-100 my-4"></div>

              {/* Contact Details */}
              <div>
                <div className="flex items-center gap-2 mb-2 text-gray-900 font-medium">
                  <User className="w-4 h-4 text-gray-500" />
                  <span>Contact</span>
                </div>
                {contact ? (
                  <div className="text-sm text-gray-600 pl-6 space-y-1">
                    <p className="font-semibold text-gray-900">
                      {[contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') || 'Unknown contact'}
                    </p>
                    {contact.properties.jobtitle && (
                      <div className="flex items-center gap-1 text-gray-500">
                        <Briefcase className="w-3 h-3" />
                        <span>{contact.properties.jobtitle}</span>
                      </div>
                    )}
                    {contact.properties.email && (
                      <div className="flex items-center gap-1 text-gray-500">
                        <Mail className="w-3 h-3" />
                        <a href={`mailto:${contact.properties.email}`} className="hover:text-blue-600 truncate">
                          {contact.properties.email}
                        </a>
                      </div>
                    )}
                    {contact.properties.phone && (
                      <div className="flex items-center gap-1 text-gray-500">
                        <Phone className="w-3 h-3" />
                        <span>{contact.properties.phone}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 pl-6 italic">No contact associated</p>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
