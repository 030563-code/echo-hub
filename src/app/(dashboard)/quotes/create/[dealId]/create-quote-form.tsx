'use client'

import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Plus, Trash2, ShoppingCart, ArrowRight, AlertCircle, FileDown, Eye, Search } from 'lucide-react'
import { SalesProfileSettings } from '@/app/actions/sales/get-profile-settings'

import { createQuote, handleQuoteFileUpload } from '@/app/actions/sales/create-quote'
import { searchHubSpotProducts } from '@/app/actions/hubspot/searchProducts'
import { getMappedSkus } from '@/app/actions/sales/get-mapped-skus'
import { getWinProbabilityOptions } from '@/app/actions/hubspot/getDealProperties'
import { updateDealProperties } from '@/app/actions/hubspot/updateDealProperties'
import { buildQuotePdf, taxRegionForTemplate } from '@/lib/quote-pdf'
import { depotLabel } from '@/lib/depot-constants'
import { loadQuoteLogo } from '@/lib/quote-logo'

interface Product {
  id: string
  properties: {
    name: string
    price: string
    description?: string
    hs_sku?: string
  }
}

interface LineItem {
  productId: string
  name: string
  sku?: string
  description?: string
  quantity: number
  unitPrice: number
  total: number
}

interface QuoteContact {
  properties: {
    firstname?: string
    lastname?: string
    jobtitle?: string
    email?: string
    phone?: string
  }
}

interface HubSpotLineItem {
  properties: {
    hs_product_id?: string
    name?: string
    hs_sku?: string
    description?: string
    quantity?: string | number | null
    price?: string | number | null
    amount?: string | number | null
  }
}

interface CreateQuoteFormProps {
  dealId: string
  dealName: string
  settings: SalesProfileSettings
  products: Product[]
  salesRep: { name: string; email: string; phone?: string }
  contact: QuoteContact | null
  companyName?: string
  initialLineItems?: HubSpotLineItem[]
  /** Depot code already on the HubSpot deal (sending_depot, reverse-mapped), if any. */
  initialDepot?: string
  /** Comments already saved for this deal (deals_registry.quote_comments), if any. */
  initialComments?: string
  /** ISO code from the deal itself. Drives every money figure the rep sees and
   *  the currency printed on the quote. */
  dealCurrency?: string
}

// Radix Select can't represent "cleared", so the undecided state gets an
// explicit sentinel item that maps back to '' in state.
const DEPOT_UNDECIDED = '__undecided__'

const mapInitialLineItems = (items: HubSpotLineItem[]): LineItem[] =>
  items.map((item) => ({
    productId: item.properties.hs_product_id ?? '',
    name: item.properties.name ?? '',
    sku: item.properties.hs_sku,
    description: item.properties.description,
    quantity: Number(item.properties.quantity) || 0,
    unitPrice: Number(item.properties.price) || 0,
    total: Number(item.properties.amount) || 0,
  }))

export default function CreateQuoteForm({ dealId, dealName, settings, products, salesRep, contact, companyName, initialLineItems = [], initialDepot = '', initialComments = '', dealCurrency = 'USD' }: CreateQuoteFormProps) {
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: dealCurrency,
    currencyDisplay: 'narrowSymbol',
  })

  // State for the Initial Setup Dialog
  const [showSetupDialog, setShowSetupDialog] = useState(true)
  const [distributor, setDistributor] = useState<string>('none')
  // Seeded from the deal's existing sending_depot (if any and still allowed) so
  // re-opening the builder doesn't misreport a decided deal as "Decide later".
  const [depot, setDepot] = useState<string>(() =>
    initialDepot && settings.allowed_depots.includes(initialDepot) ? initialDepot : ''
  )
  const [template, setTemplate] = useState<string>('')
  const [winProbability, setWinProbability] = useState<string>('')
  const [winProbabilityOptions, setWinProbabilityOptions] = useState<{ label: string; value: string }[]>([])
  const [setupLoading, setSetupLoading] = useState(false)

  // State for Quote Builder
  const [lineItems, setLineItems] = useState<LineItem[]>(() => mapInitialLineItems(initialLineItems))
  // Free-text rep comments — printed on the quote under "Comments from {rep}".
  const [comments, setComments] = useState<string>(initialComments)
  const [submitting, setSubmitting] = useState(false)
  // Latches true after a successful generate. addLineItemsToDeal REPLACES the
  // deal's line items (idempotent), so this guards against accidental
  // re-writes, not against duplication.
  const [submitted, setSubmitted] = useState(false)
  const submittingRef = useRef(false)
  const [selectedProduct, setSelectedProduct] = useState<string>('')
  const [productSearch, setProductSearch] = useState('')
  const [filteredProducts, setFilteredProducts] = useState<Product[]>(products)
  const [allowedSkusForDepot, setAllowedSkusForDepot] = useState<string[]>([])
  // Tracks whether the attach-to-HubSpot step (run after the quote itself is
  // saved) actually succeeded, so the success message can't render next to a
  // failed upload just because `submitted` flipped first.
  const [attachStatus, setAttachStatus] = useState<'pending' | 'ok' | 'failed'>('pending')
  const [retryingAttach, setRetryingAttach] = useState(false)
  // Holds the last generated PDF so "Retry attach" can re-run just the upload
  // step without regenerating (and re-saving) the whole quote.
  const lastPdfRef = useRef<{ blob: Blob; filename: string } | null>(null)
  const prevDepotRef = useRef<string | null>(null)

  useEffect(() => {
    async function fetchWinProbability() {
      const result = await getWinProbabilityOptions()
      if (result.success && result.data) {
        setWinProbabilityOptions(result.data)
      }
    }
    fetchWinProbability()
  }, [])



  // Warn (don't block) when the depot is changed via "Edit setup" after items
  // are already in the cart — those items may not be stocked at the new depot.
  // Actual availability is re-checked server-side on submit.
  useEffect(() => {
    const prevDepot = prevDepotRef.current
    if (prevDepot !== null && prevDepot !== depot && lineItems.length > 0) {
      toast.warning(
        depot
          ? `Depot changed to ${depotLabel(depot)}. Items already in the cart may not be available from this depot. Availability will be checked on submit.`
          : 'Sending depot set to "Decide later". Items in the cart will be checked against all your depots on submit.'
      )
    }
    prevDepotRef.current = depot
  }, [depot, lineItems.length])

  // Filter products based on search AND depot restrictions
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      // Base list is either all products or restricted by depot
      let baseProducts = products
      if (allowedSkusForDepot.length > 0) {
        baseProducts = products.filter(p => p.properties.hs_sku && allowedSkusForDepot.includes(p.properties.hs_sku))
      }

      if (productSearch) {
        // Local filter
        const lowerSearch = productSearch.toLowerCase()
        const localResults = baseProducts.filter(p => 
          p.properties.name.toLowerCase().includes(lowerSearch) || 
          p.properties.hs_sku?.toLowerCase().includes(lowerSearch)
        )
        
        setFilteredProducts(localResults)

        // API Search (if we want to find products not in the initial 100)
        if (productSearch.length > 2) {
           const result = await searchHubSpotProducts(productSearch)
           if (result.success && result.data) {
             // Filter API results by depot restrictions too
             let newProducts = result.data.filter(apiP => !products.some(localP => localP.id === apiP.id))
             
             if (allowedSkusForDepot.length > 0) {
               newProducts = newProducts.filter(p => p.properties.hs_sku && allowedSkusForDepot.includes(p.properties.hs_sku))
             }

             setFilteredProducts([...localResults, ...newProducts])
           }
        }
      } else {
        setFilteredProducts(baseProducts)
      }
    }, 500)

    return () => clearTimeout(delayDebounceFn)
  }, [productSearch, products, allowedSkusForDepot])

  // Derived State
  const isDistributorSelected = distributor !== 'none' && distributor !== ''

  // Fetch allowed SKUs when depot changes (or on initial load if depot is set).
  // Guarded against out-of-order responses: the mount-time union fetch must not
  // overwrite a later depot-specific one.
  const skuFetchSeqRef = useRef(0)
  useEffect(() => {
    const seq = ++skuFetchSeqRef.current
    async function fetchSkus() {
      // Distributor fulfilment isn't depot-bound — the full catalog applies,
      // exactly as before depots became optional.
      if (isDistributorSelected) {
        setAllowedSkusForDepot([])
        return
      }
      if (depot || settings.allowed_depots.length > 0) {
        const result = await getMappedSkus(depot || settings.allowed_depots)
        if (seq !== skuFetchSeqRef.current) return
        setAllowedSkusForDepot(result.data || [])
      } else {
        setAllowedSkusForDepot([])
      }
    }
    fetchSkus()
  }, [depot, settings.allowed_depots, isDistributorSelected])
  // Depot is deliberately NOT required here — it's the fulfilment decision,
  // chosen at latest when the deal is moved to Quotation Accepted (the Change
  // Stage dialog + updateDealStage both require it at that transition).
  const canProceedFromSetup = template !== '' && winProbability !== ''

  // Opening the builder must NOT touch the customer's deal. The win probability
  // is pushed to HubSpot on SUBMIT instead (see runGeneratePDF), so previewing a
  // quote — or backing out of one — leaves the CRM record exactly as it was.
  const handleSetupComplete = () => {
    if (!canProceedFromSetup) return
    setShowSetupDialog(false)
  }

  const addLineItem = () => {
    if (!selectedProduct) return

    // Search in filteredProducts first (which includes API results), then fallback to initial products
    const product = filteredProducts.find(p => p.id === selectedProduct) || products.find(p => p.id === selectedProduct)
    
    if (!product) {
      console.error('Product not found for ID:', selectedProduct)
      return
    }

    const newItem: LineItem = {
      productId: product.id,
      name: product.properties.name,
      sku: product.properties.hs_sku,
      // Prefilled from HubSpot, freely editable — this is what prints on the quote.
      description: product.properties.description,
      quantity: 1,
      unitPrice: Number(product.properties.price) || 0,
      total: Number(product.properties.price) || 0
    }

    setLineItems([...lineItems, newItem])
    setSelectedProduct('')
  }

  const updateLineItem = (index: number, field: keyof LineItem, value: number) => {
    const newItems = [...lineItems]
    const item = newItems[index]

    // Friendly-layer clamp: the server validates too, but negative/fractional
    // quantities and negative prices shouldn't even render as a valid total here.
    if (field === 'quantity') {
      item.quantity = Math.max(0, Math.trunc(value) || 0)
      item.total = item.quantity * item.unitPrice
    } else if (field === 'unitPrice') {
      item.unitPrice = Math.max(0, value)
      item.total = item.quantity * item.unitPrice
    }

    setLineItems(newItems)
  }

  const updateLineItemDescription = (index: number, description: string) => {
    const newItems = [...lineItems]
    newItems[index] = { ...newItems[index], description }
    setLineItems(newItems)
  }

  const removeLineItem = (index: number) => {
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  const calculateGrandTotal = () => {
    const sum = lineItems.reduce((acc, item) => acc + (Number(item.total) || 0), 0)
    return Math.round(sum * 100) / 100
  }

  // Friendly-layer validation: the server re-validates on submit, but there's
  // no reason to let Generate fire with a line item that can't possibly be valid.
  const hasInvalidLineItems = lineItems.some((item) => item.quantity < 1 || item.unitPrice < 0)

  const generatePDF = async (previewMode = false) => {
    // In-flight guard: prevent double-submit duplicating HubSpot line items + note.
    if (!previewMode) {
      if (submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
    }

    try {
      await runGeneratePDF(previewMode)
    } finally {
      if (!previewMode) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  const runGeneratePDF = async (previewMode: boolean) => {
    let quoteRef = 'PREVIEW'

    if (!previewMode) {
      // 1. Save Quote to Database (Only if NOT preview)
      const result = await createQuote({
        dealId,
        distributor: isDistributorSelected ? distributor : 'Direct Sale',
        depot: depot || undefined,
        template,
        lineItems,
        totalAmount: calculateGrandTotal(),
        winProbability, // backbone: persisted to deals_registry.deal_probability
        comments,
        isPreview: false
      })

      if (!result.success) {
        toast.error('Failed to save quote: ' + result.error)
        return
      }

      // Now that the quote is committed, mirror the win probability onto the
      // HubSpot deal. Non-fatal: the value is already persisted to
      // deals_registry.deal_probability, which is what the forecasting engine reads.
      const probResult = await updateDealProperties(dealId, { win_probability: winProbability })
      if (!probResult.success) {
        console.error('win_probability sync failed:', probResult.error)
      }

      setSubmitted(true)

      quoteRef = result.quoteReference || 'DRAFT'
    } else {
      // Preview Mode: Just generate PDF, don't call server action
      quoteRef = 'PREVIEW'
    }

    // 2. Build the PDF. Drawing lives in the pure quote-pdf module; this
    // component only supplies the facts (including the clock, since the
    // module must not read it itself) and then handles preview/save/upload.
    const contactName = contact
      ? [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') || undefined
      : undefined
    const grandTotal = calculateGrandTotal()
    const createdAt = new Date()
    const logoDataUrl = await loadQuoteLogo()
    const doc = await buildQuotePdf({
      logoDataUrl,
      // The quote template doubles as the tax jurisdiction (US / CAN). It is
      // mandatory at setup, so a generated quote always carries the right line.
      taxRegion: taxRegionForTemplate(template),
      currency: dealCurrency,
      dealName,
      quoteReference: quoteRef,
      createdAt,
      companyName,
      contactName,
      contactEmail: contact?.properties.email,
      contactPhone: contact?.properties.phone,
      salesRep,
      comments,
      lineItems: lineItems.map((item) => ({
        name: item.name,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
      })),
      grandTotal,
    })

    if (previewMode) {
      // Open in new tab for preview
      const pdfBlob = doc.output('blob')
      const pdfUrl = URL.createObjectURL(pdfBlob)
      window.open(pdfUrl, '_blank')
    } else {
      // Download for final generation
      doc.save(`quote_${quoteRef}.pdf`)

      // 4. Upload to HubSpot (Only if NOT preview)
      const pdfBlob = doc.output('blob')
      const filename = `quote_${quoteRef}.pdf`
      lastPdfRef.current = { blob: pdfBlob, filename }
      await attemptQuoteUpload(pdfBlob, filename)
    }
  }

  // Shared by the initial upload and "Retry attach" — keeps the attach outcome
  // (attachStatus) honest instead of borrowing the quote-saved state (submitted).
  const attemptQuoteUpload = async (pdfBlob: Blob, filename: string) => {
    const formData = new FormData()
    formData.append('file', pdfBlob, filename)
    formData.append('dealId', dealId)

    const uploadResult = await handleQuoteFileUpload(formData)
    if (uploadResult.success) {
      setAttachStatus('ok')
      // Redirect to HubSpot Deal Record in new tab
      // Note: Using the portal ID from env or default
      const portalId = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
      if (portalId) {
        window.open(`https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`, '_blank')
      }
    } else {
      setAttachStatus('failed')
      console.error('Failed to upload PDF:', uploadResult.error)
      toast.error('Quote saved but failed to upload to HubSpot: ' + uploadResult.error)
    }
  }

  const handleRetryAttach = async () => {
    if (!lastPdfRef.current || retryingAttach) return
    setRetryingAttach(true)
    try {
      await attemptQuoteUpload(lastPdfRef.current.blob, lastPdfRef.current.filename)
    } finally {
      setRetryingAttach(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Setup Dialog */}
      <Dialog open={showSetupDialog} onOpenChange={setShowSetupDialog}>
        <DialogContent
          className="sm:max-w-[500px] bg-white text-gray-900 border-gray-200 shadow-xl [&>button]:hidden"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="text-xl font-bold uppercase tracking-wide text-gray-900">Quote Setup</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Distributor Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium">Select sales team</Label>
              <Select
                value={distributor}
                onValueChange={setDistributor}
                disabled={settings.allowed_distributors.length === 0}
              >
                <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow focus:border-echo-yellow">
                  <SelectValue placeholder="Select sales team" />
                </SelectTrigger>
                <SelectContent className="bg-white border-gray-200 text-gray-900">
                  <SelectItem value="none" className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">Echo Barrier direct</SelectItem>
                  {settings.allowed_distributors.map((dist) => (
                    <SelectItem key={dist} value={dist} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{dist}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isDistributorSelected ? (
                <p className="text-xs font-medium text-amber-700 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  This deal will be moved to the Passed to Distributor stage, not Quotation Sent.
                </p>
              ) : settings.allowed_distributors.length === 0 ? (
                <p className="text-xs text-gray-500">
                  No partner sales teams are configured for your region, so this is a direct sale.
                </p>
              ) : null}
            </div>

            {/* Depot Selection (Only if no distributor) */}
            {!isDistributorSelected && (
              <div className="space-y-2">
                <Label className="text-gray-700 font-medium">Sending Depot (optional)</Label>
                <Select
                  value={depot === '' ? DEPOT_UNDECIDED : depot}
                  onValueChange={(v) => setDepot(v === DEPOT_UNDECIDED ? '' : v)}
                >
                  <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow">
                    <SelectValue placeholder="Decide later" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-gray-200 text-gray-900">
                    <SelectItem value={DEPOT_UNDECIDED} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                      Decide later
                    </SelectItem>
                    {settings.allowed_depots.map((d) => (
                      <SelectItem key={d} value={d} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                        {depotLabel(d)} <span className="text-gray-400">({d})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  The depot is required when the deal is marked Quotation Accepted, and it can be
                  chosen then. Without one, the product list covers all your depots.
                </p>
              </div>
            )}

            {/* Template Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium">Quote Template *</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow focus:border-echo-yellow">
                  <SelectValue placeholder="Select Template..." />
                </SelectTrigger>
                <SelectContent className="bg-white border-gray-200 text-gray-900">
                  {settings.allowed_quote_templates.length > 0 ? (
                    settings.allowed_quote_templates.map((t) => (
                      <SelectItem key={t} value={t} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{t}</SelectItem>
                    ))
                  ) : (
                    <SelectItem value="default" className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">Standard Quote Template</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Win Probability Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium">Win Probability *</Label>
              <Select value={winProbability} onValueChange={setWinProbability}>
                <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow focus:border-echo-yellow">
                  <SelectValue placeholder="Select win probability..." />
                </SelectTrigger>
                <SelectContent className="bg-white border-gray-200 text-gray-900">
                  {winProbabilityOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={handleSetupComplete}
              disabled={!canProceedFromSetup || setupLoading}
              className="w-full min-h-11 sm:min-h-0 bg-echo-yellow text-black hover:bg-echo-yellow/90"
            >
              {setupLoading ? 'Saving...' : <>Start Quote <ArrowRight className="w-4 h-4 ml-2" /></>}
              {/* setupLoading is retained for future async setup steps */}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chosen setup, with a way back in — the dialog is otherwise one-way. */}
      {!showSetupDialog && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
          <span>
            <span className="font-medium text-gray-900">
              {isDistributorSelected ? distributor : depot ? depotLabel(depot) : '—'}
            </span>{' '}
            · template {template || '—'} · {winProbability || '—'} to close
          </span>
          <button
            type="button"
            className="inline-flex items-center min-h-11 sm:min-h-0 text-sm font-medium text-gray-900 underline underline-offset-2 hover:text-black"
            onClick={() => setShowSetupDialog(true)}
          >
            Edit setup
          </button>
        </div>
      )}

      {/* Main Quote Builder UI */}
      {!showSetupDialog && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
          {/* Left: Line Items */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="p-6 bg-white border-gray-200">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-0 mb-6">
                <h2 className="text-lg font-bold text-gray-900">Line Items</h2>
                <div className="flex flex-wrap lg:flex-nowrap gap-2 items-center">
                  <div className="relative w-full lg:w-[300px]">
                    <Search className="absolute left-2 top-3.5 lg:top-2.5 h-4 w-4 text-gray-400" />
                    <Input 
                      placeholder="Search products..." 
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="pl-8 h-11 lg:h-10 bg-white border-gray-300 text-gray-900"
                    />
                  </div>
                  <Select value={selectedProduct} onValueChange={setSelectedProduct}>
                    <SelectTrigger className="max-lg:min-w-0 grow basis-0 lg:grow-0 lg:basis-auto lg:w-[250px] bg-white border-gray-300 text-gray-900">
                      <SelectValue placeholder="Select Product..." />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-gray-200 text-gray-900 max-h-[300px] max-w-[calc(100vw-1rem)]">
                      {filteredProducts.length > 0 ? (
                        filteredProducts.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="py-3 sm:py-1.5 hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                            {p.properties.name} ({money.format(Number(p.properties.price))})
                          </SelectItem>
                        ))
                      ) : (
                        <div className="p-2 text-sm text-gray-500 text-center">No products found</div>
                      )}
                    </SelectContent>
                  </Select>
                  <Button onClick={addLineItem} disabled={!selectedProduct} size="icon" className="min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 bg-echo-yellow text-black hover:bg-echo-yellow/90">
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {lineItems.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-lg">
                  <ShoppingCart className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No items added yet.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {lineItems.map((item, index) => (
                    <div key={index} className="p-4 bg-gray-50 rounded-lg border border-gray-100 space-y-3">
                      <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:gap-4">
                        <div className="col-span-2 max-sm:min-w-0 sm:flex-1">
                          <p className="font-medium text-gray-900 break-words">{item.name}</p>
                          <p className="text-xs text-gray-500">SKU: {item.sku || 'N/A'}</p>
                        </div>

                        <div className="max-sm:min-w-0 sm:w-24">
                          <Label className="text-xs text-gray-500">Qty</Label>
                          <Input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onChange={(e) => updateLineItem(index, 'quantity', parseInt(e.target.value) || 0)}
                            className="h-11 sm:h-8"
                          />
                        </div>

                        <div className="max-sm:min-w-0 sm:w-32">
                          <Label className="text-xs text-gray-500">Price</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.unitPrice}
                            onChange={(e) => updateLineItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                            className="h-11 sm:h-8"
                          />
                        </div>

                        <div className="sm:w-24 text-left sm:text-right">
                          <Label className="text-xs text-gray-500">Total</Label>
                          <p className="font-mono font-medium pt-1">
                            {money.format(item.total)}
                          </p>
                        </div>

                        <Button
                          variant="ghost"
                          size="icon"
                          className="justify-self-end self-end sm:self-center min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => removeLineItem(index)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>

                      <div>
                        <Label className="text-xs text-gray-500">Description (shown on the quote, under the item name)</Label>
                        <Input
                          value={item.description || ''}
                          onChange={(e) => updateLineItemDescription(index, e.target.value)}
                          placeholder="e.g. Green PVC front / black back / acoustic absorbent inside"
                          className="h-11 sm:h-8 sm:text-sm"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6 bg-white border-gray-200">
              <Label className="text-gray-900 font-medium">Comments</Label>
              <p className="text-xs text-gray-500 mb-2">
                {`Shown on the quote under "Comments from ${salesRep.name}". Use it for things the`}{' '}
                customer needs to know: ship-from, what the quote assumes, panel layout or
                dimensions, what&apos;s optional.
              </p>
              <Textarea
                rows={7}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder={"e.g. In stock and ready to ship from Baltimore, MD\nFitting Kits optional - 1 hook + 2 bungees\n\nQuote based on:\nPanels only - substrate by others. Recommended scaffolding."}
                className="sm:text-sm"
              />
            </Card>
          </div>

          {/* Right: Summary & Actions */}
          <div className="space-y-6">
            <Card className="p-6 bg-white border-gray-200 lg:sticky lg:top-24">
              <h3 className="text-lg font-bold text-gray-900 mb-4">Quote Summary</h3>
              
              <div className="space-y-3 text-sm border-b border-gray-100 pb-4 mb-4">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Sales team</span>
                  <span className="font-medium text-gray-900 text-right">{isDistributorSelected ? distributor : 'Echo Barrier direct'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Depot</span>
                  <span className="font-medium text-gray-900 text-right">
                    {isDistributorSelected ? 'N/A' : depot ? depotLabel(depot) : 'Decided at acceptance'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Template</span>
                  <span className="font-medium text-gray-900 text-right">{template}</span>
                </div>
              </div>

              <div className="flex justify-between items-end mb-6">
                <span className="text-gray-500 font-medium">Grand Total</span>
                <span className="text-2xl font-bold text-gray-900">
                  {money.format(calculateGrandTotal())}
                </span>
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  onClick={() => generatePDF(true)}
                  disabled={lineItems.length === 0 || submitting}
                  variant="outline"
                  className="w-full border-gray-300 text-gray-700 hover:bg-gray-50 font-bold min-h-12 sm:h-12 max-sm:text-base"
                >
                  <Eye className="w-5 h-5 mr-2" />
                  Preview Quote
                </Button>

                <Button
                  onClick={() => generatePDF(false)}
                  disabled={lineItems.length === 0 || submitting || submitted || hasInvalidLineItems}
                  className="w-full bg-echo-yellow text-white hover:bg-[#4a5e29] font-bold min-h-12 sm:h-12 max-sm:text-base"
                >
                  <FileDown className="w-5 h-5 mr-2" />
                  {submitting
                    ? 'Generating...'
                    : submitted
                      ? 'Quote generated'
                      : 'Generate Quote & Attach to HubSpot'}
                </Button>
                {hasInvalidLineItems && !submitted && (
                  <p className="text-xs text-red-600 text-center">
                    Fix line item quantities (at least 1) and prices (0 or more) to generate.
                  </p>
                )}
                {submitted ? (
                  attachStatus === 'pending' ? (
                    <p className="text-xs text-gray-500 text-center">
                      Quote saved. Attaching the PDF to the HubSpot deal…
                    </p>
                  ) : attachStatus === 'ok' ? (
                    <p className="text-xs text-green-600 text-center">
                      Attached to the HubSpot deal and downloaded. Nothing has been emailed to the
                      customer. Send it yourself from HubSpot.
                    </p>
                  ) : (
                    <div className="text-center space-y-2">
                      <p className="text-xs text-amber-600">
                        PDF downloaded. Attaching it to the HubSpot deal failed. The quote data is saved.
                      </p>
                      <Button
                        onClick={handleRetryAttach}
                        disabled={retryingAttach}
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-0 border-gray-300 text-gray-700 hover:bg-gray-50"
                      >
                        {retryingAttach ? 'Retrying...' : 'Retry attach'}
                      </Button>
                    </div>
                  )
                ) : (
                  <p className="text-xs text-gray-500 text-center">
                    Attaches the PDF to the HubSpot deal and downloads a copy. Does not email the customer.
                  </p>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}