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
import {
  Plus, Trash2, ShoppingCart, ArrowRight, ArrowLeft, AlertCircle, Search, Send,
  Users, Warehouse, FileText, Percent,
} from 'lucide-react'
import { SalesProfileSettings } from '@/app/actions/sales/get-profile-settings'

import { RepAgentSelect } from '@/components/quotes/rep-agent-select'
import { REP_AGENT_LABEL, REP_AGENT_PROPERTY } from '@/lib/deal-properties'

import { createQuote } from '@/app/actions/sales/create-quote'
import { republishEditedQuote } from '@/app/actions/sales/edit-quote'
import { searchHubSpotProducts } from '@/app/actions/hubspot/searchProducts'
import { getMappedSkus } from '@/app/actions/sales/get-mapped-skus'
import { getWinProbabilityOptions } from '@/app/actions/hubspot/getDealProperties'
import { updateDealProperties } from '@/app/actions/hubspot/updateDealProperties'
import { depotLabel } from '@/lib/depot-constants'
import { WIN_PROBABILITY_VALUES, roundCents, validateLineItems } from '@/lib/quote-math'
import { priceCart, type CartLine } from '@/lib/quote-pricing'
import type { EditableCartLine } from '@/lib/quote-edit'
import { retryHubSpotQuote } from '@/app/actions/sales/publish-quote'
import {
  QuoteFailedPanel,
  QuotePublishedPanel,
  type PublishedQuoteView,
} from '@/components/quotes/quote-published-panel'
import { describeCap, type ContractPriceRow, type DiscountCap, type DiscountMode, type ListPriceRow } from '@/lib/pricing'
import { useRouter } from 'next/navigation'

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
  /**
   * The three numeric fields are held as free-text STRINGS so a box can be
   * cleared and retyped, and are coerced to numbers only at the boundary
   * (toNumeric). The raise-po form learned this first and wrote down why.
   *
   * Holding them as numbers is what produced "0200". React updates a
   * `type="number"` input only when `node.value != value`, and "0200" != 200
   * is false, so React left the DOM alone and the box stayed wrong for good.
   * The `|| 0` fallback then re-rendered a 0 that could not be deleted or
   * typed in front of.
   */
  quantity: string
  /** What the rep typed. Only used for a SKU with no Supabase price; for
   *  everything else the resolved base wins on both sides. */
  unitPrice: string
  discountMode?: DiscountMode
  discountValue?: string
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
  /** win_probability already on the HubSpot deal, e.g. '70%'. */
  initialWinProbability?: string
  /** The rep agent already on the HubSpot deal, if any. Optional field, so
   *  unlike the template and probability it never blocks the setup step. */
  initialRepAgent?: string
  /** Will Call already on deals_registry, so re-opening the builder shows the
   *  deal's current answer rather than re-asking it. */
  initialIsCollection?: boolean
  /**
   * Set when this is an edit of a recalled quote rather than a new one.
   *
   * While it is set the customer's link is OFFLINE: HubSpot blanks
   * hs_quote_link the moment a quote goes back to DRAFT, and only restores it
   * on republish. That is why the banner is loud and the primary button says
   * Republish rather than Generate.
   */
  editing?: {
    dealQuoteId: string
    quoteNumber: string | null
    linkBeforeEdit: string | null
    /** The published quote's own snapshot, numeric as it was stored. The form
     *  converts it to its own string-held fields with fromCartLine. */
    cartLines: EditableCartLine[]
  }
  /** The price list, the customer's contract prices and this rep's discount
   *  limit, loaded once by the page. The browser prices the cart with the same
   *  pure function the server does, so it never offers a discount the server
   *  will refuse. */
  pricing?: {
    listPrices: ListPriceRow[]
    contractPrices: ContractPriceRow[]
    cap: DiscountCap | null
    contractorName: string | null
    isSuperAdmin: boolean
  }
  /** The deal's HubSpot company, which is what a contract price is keyed to. */
  companyId?: string | null
}

// Radix Select can't represent "cleared", so the undecided state gets an
// explicit sentinel item that maps back to '' in state.
const DEPOT_UNDECIDED = '__undecided__'

/** A number as input text. Zero and anything non-numeric seed '' so the box
 *  starts EMPTY rather than holding a 0 the rep has to delete first. */
const numberToField = (value: unknown): string => {
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? String(n) : ''
}

/** Input text as a number. '' is 0 (an empty price is a free line, as before).
 *  Anything else that is not a number stays NaN, so validateLineItems refuses
 *  it instead of the line quietly pricing at zero. */
const fieldToNumber = (value: string): number => (value.trim() === '' ? 0 : Number(value.trim()))

/** The ONE place a cart line becomes numbers. Every consumer (pricing, the
 *  totals, both submit payloads) goes through here, so none can drift. */
const toNumeric = (item: LineItem): CartLine => ({
  productId: item.productId,
  name: item.name,
  sku: item.sku,
  description: item.description,
  quantity: fieldToNumber(item.quantity),
  unitPrice: fieldToNumber(item.unitPrice),
  discountMode: item.discountMode,
  discountValue: item.discountValue?.trim() ? Number(item.discountValue) : undefined,
})

/** The reverse, for edit mode: the stored quote snapshot is numeric. */
const fromCartLine = (line: EditableCartLine): LineItem => ({
  productId: line.productId,
  name: line.name,
  sku: line.sku,
  description: line.description,
  quantity: numberToField(line.quantity),
  unitPrice: numberToField(line.unitPrice),
  discountMode: line.discountMode,
  discountValue: line.discountValue != null ? numberToField(line.discountValue) : undefined,
})

const mapInitialLineItems = (items: HubSpotLineItem[]): LineItem[] =>
  items.map((item) => ({
    productId: item.properties.hs_product_id ?? '',
    name: item.properties.name ?? '',
    sku: item.properties.hs_sku,
    description: item.properties.description,
    quantity: numberToField(item.properties.quantity),
    unitPrice: numberToField(item.properties.price),
  }))

export default function CreateQuoteForm({ dealId, dealName, settings, products, salesRep, contact, companyName, initialLineItems = [], initialDepot = '', initialComments = '', dealCurrency = 'USD', initialWinProbability = '', initialRepAgent = '', initialIsCollection = false, editing, pricing, companyId = null }: CreateQuoteFormProps) {
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: dealCurrency,
    currencyDisplay: 'narrowSymbol',
  })

  // State for the Initial Setup Dialog
  const router = useRouter()
  // Never opened on an edit. Every field it asks for is already fixed on the
  // existing quote, and the template association in particular CANNOT be
  // changed after creation, so asking again would offer a choice that does not
  // exist.
  const [showSetupDialog, setShowSetupDialog] = useState(!editing)
  // Distinguishes the first, blocking open from a later re-open via Edit setup.
  const [hasCompletedSetup, setHasCompletedSetup] = useState(!!editing)
  const [distributor, setDistributor] = useState<string>('none')
  // Seeded from the deal's existing sending_depot (if any and still allowed) so
  // re-opening the builder doesn't misreport a decided deal as "Decide later".
  const [depot, setDepot] = useState<string>(() =>
    initialDepot && settings.allowed_depots.includes(initialDepot) ? initialDepot : ''
  )
  const [template, setTemplate] = useState<string>('')
  // Seeded from the deal's own win_probability, mirroring the depot seeding
  // above, so re-opening the builder does not re-ask a question the deal has
  // already answered. Honest limit: once the create-deal wizard stops asking
  // for it, a Hub-created deal carries none, so this helps HubSpot-originated
  // deals and re-opens after a Generate (which PATCHes the property).
  const [winProbability, setWinProbability] = useState<string>(() =>
    initialWinProbability && WIN_PROBABILITY_VALUES.includes(initialWinProbability)
      ? initialWinProbability
      : ''
  )
  // Seeded raw rather than filtered against the known values, because unlike
  // win_probability this list is editable in HubSpot: a value we do not
  // recognise is more likely a new option than a bad one, and RepAgentSelect
  // says so on screen rather than dropping it.
  const [repAgent, setRepAgent] = useState<string>(initialRepAgent)
  // Will Call. Answered here so the depot decision and the collect decision are
  // made together, carried on deals_registry, confirmed at acceptance, and used
  // to seed the draft invoice. Never blocks Generate: an undecided quote is
  // simply a delivered one, which is what every quote was before this existed.
  const [isCollection, setIsCollection] = useState<boolean>(initialIsCollection)
  const [winProbabilityOptions, setWinProbabilityOptions] = useState<{ label: string; value: string }[]>([])
  const [setupLoading, setSetupLoading] = useState(false)

  // State for Quote Builder
  // An edit seeds from the published quote's own snapshot, which carries the
  // discounts; mapInitialLineItems drops them, so seeding an edit from the
  // deal's line items would quietly republish at full price.
  const [lineItems, setLineItems] = useState<LineItem[]>(() =>
    editing ? editing.cartLines.map(fromCartLine) : mapInitialLineItems(initialLineItems)
  )
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
  // What HubSpot came back with, or why it did not. Both are terminal states
  // for this page: the deal writes are already done either way.
  const [publishedQuote, setPublishedQuote] = useState<PublishedQuoteView | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  // Holds the last generated PDF so "Retry attach" can re-run just the upload
  // step without regenerating (and re-saving) the whole quote.
  const prevDepotRef = useRef<string | null>(null)

  useEffect(() => {
    async function fetchWinProbability() {
      const result = await getWinProbabilityOptions()
      if (result.success && result.data && result.data.length > 0) {
        setWinProbabilityOptions(result.data)
      } else {
        // Fall back to the known option set rather than rendering an empty
        // select. The dialog cannot be dismissed without a probability, so an
        // empty list used to brick the builder on a transient network error.
        setWinProbabilityOptions(WIN_PROBABILITY_VALUES.map((v) => ({ label: v, value: v })))
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
    setHasCompletedSetup(true)
    setShowSetupDialog(false)
  }

  /**
   * The only exit from the setup dialog.
   *
   * showSetupDialog gates the ENTIRE builder, so simply closing it on first
   * open renders a page containing nothing but the empty summary line. Before
   * setup is done the only sensible destination is the deal itself; after it,
   * closing means "I was just re-checking" and the builder is behind it.
   */
  const handleSetupOpenChange = (open: boolean) => {
    if (open) {
      setShowSetupDialog(true)
      return
    }
    if (hasCompletedSetup) setShowSetupDialog(false)
    else router.push(`/quotes/deals/${dealId}`)
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
      quantity: '1',
      unitPrice: numberToField(product.properties.price),
    }

    setLineItems([...lineItems, newItem])
    setSelectedProduct('')
  }

  /** A discount is stored as the rep entered it, percentage or money off each
   *  unit, and resolved into prices by priceCart. Storing the entry rather than
   *  the result keeps one source of truth for what they chose. */
  const updateLineItemDiscount = (index: number, patch: { mode?: DiscountMode; value?: string }) => {
    const newItems = [...lineItems]
    newItems[index] = {
      ...newItems[index],
      ...(patch.mode !== undefined ? { discountMode: patch.mode } : {}),
      ...(patch.value !== undefined ? { discountValue: patch.value } : {}),
    }
    setLineItems(newItems)
  }

  /**
   * Stores exactly what was typed. No clamping and no truncation here on
   * purpose: rewriting the value mid-edit is what stopped the box from being
   * clearable. An impossible entry is caught by validateLineItems below, which
   * is the server's own rule, and Generate stays disabled until it passes.
   */
  const updateLineItem = (index: number, field: 'quantity' | 'unitPrice', value: string) => {
    setLineItems((items) => items.map((it, i) => (i === index ? { ...it, [field]: value } : it)))
  }

  const updateLineItemDescription = (index: number, description: string) => {
    const newItems = [...lineItems]
    newItems[index] = { ...newItems[index], description }
    setLineItems(newItems)
  }

  const removeLineItem = (index: number) => {
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  /**
   * Price every line with the SAME pure function createQuote runs, one line at
   * a time so a refusal can be shown against the row that caused it.
   *
   * Prices come from Supabase, so the number the rep sees is the number the
   * server will use. Before this, the browser's figure WAS the price, which is
   * how a 1.00 HubSpot placeholder could reach a customer quote.
   */
  const today = new Date().toISOString().slice(0, 10)
  /** The cart as numbers, computed once and reused by pricing, the totals and
   *  both submit payloads. */
  const numericLines = lineItems.map(toNumeric)
  const pricedLines = numericLines.map((line) =>
    priceCart({
      lines: [line],
      currency: dealCurrency,
      companyId,
      listPrices: pricing?.listPrices,
      contractPrices: pricing?.contractPrices,
      cap: pricing?.cap,
      isSuperAdmin: pricing?.isSuperAdmin,
      today,
    }),
  )

  const calculateGrandTotal = () => {
    const sum = pricedLines.reduce((acc, r) => acc + (r.ok ? r.lines[0].lineTotal : 0), 0)
    return Math.round(sum * 100) / 100
  }

  // Friendly-layer validation: the server re-validates on submit, but there's
  // no reason to let Generate fire with a line item that can't possibly be
  // valid, or with a discount the server is going to refuse anyway.
  // The server's OWN rule, not a second copy of it, so the button can never
  // enable for a line createQuote is about to refuse. It also catches a box
  // holding letters: fieldToNumber leaves those NaN.
  const lineItemsError = validateLineItems(numericLines)
  const hasInvalidLineItems = lineItemsError !== null || pricedLines.some((r) => !r.ok)

  const generate = async () => {
    // In-flight guard against a double click. The server has its own, on the
    // deal_quotes row, because this one is client state and dies on refresh.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await (editing ? runRepublish() : runGenerate())
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  /**
   * Republish a recalled quote on its existing link.
   *
   * Deliberately does NOT go through createQuote: the deal has already been
   * moved to Quotation sent and the quote object already exists, so re-running
   * the stage move and minting a second quote is exactly what an edit is meant
   * to avoid. The server re-prices and re-checks the discount caps itself.
   */
  const runRepublish = async () => {
    if (!editing) return
    const result = await republishEditedQuote({
      dealQuoteId: editing.dealQuoteId,
      lines: numericLines,
      comments,
    })

    if (!result.success) {
      // The quote is still sitting in HubSpot as a draft with its link offline,
      // so this has to read as unfinished business, not a tidy failure.
      setQuoteError(result.error)
      toast.error(result.error)
      return
    }

    setSubmitted(true)
    setPublishedQuote({ ...result.quote, currency: dealCurrency })
    setQuoteError(null)

    if (result.quote.linkChanged) {
      // The whole point of an edit is that the customer's existing link keeps
      // working. If HubSpot ever stops reissuing the same url this is the one
      // moment somebody can still act on it.
      toast.warning('HubSpot issued a NEW link for this quote, so the one already sent no longer works. Send the new link.', {
        duration: 15000,
      })
    } else {
      toast.success('Quote republished on the same link')
    }

    if (result.resyncError) {
      toast.warning(result.resyncError, { duration: 15000 })
    }
  }

  const runGenerate = async () => {
    const result = await createQuote({
      dealId,
      distributor: isDistributorSelected ? distributor : 'Direct Sale',
      depot: depot || undefined,
      template,
      // `total` is required by the action's interface and recomputed there, so
      // this value is only ever a courtesy.
      lineItems: numericLines.map((line) => ({
        ...line,
        total: roundCents(line.quantity * line.unitPrice),
      })),
      totalAmount: calculateGrandTotal(),
      winProbability, // backbone: persisted to deals_registry.deal_probability
      comments,
      // A distributor quote has no depot, so it can have no collection either.
      isCollection: isDistributorSelected ? false : isCollection,
      isPreview: false,
    })

    if (!result.success) {
      toast.error('Failed to save quote: ' + result.error)
      return
    }

    // The deal, its line items and the Hub record are committed from here on,
    // whatever HubSpot does with the quote, so the button latches.
    setSubmitted(true)

    // Mirror the probability onto the HubSpot deal. Non-fatal: the value is
    // already in deals_registry.deal_probability, which is what the forecasting
    // engine reads.
    //
    // The rep agent rides along in the SAME call rather than going through
    // createQuote. It is a HubSpot-only attribution field, nothing in
    // deals_registry or the MRP engine reads it, so there is no reason to widen
    // the server action's contract for it. Sent only when set, so an untouched
    // dropdown cannot blank a value someone chose in HubSpot.
    const dealPropertyPatch: Record<string, string> = { win_probability: winProbability }
    if (repAgent.trim()) dealPropertyPatch[REP_AGENT_PROPERTY] = repAgent.trim()
    const probResult = await updateDealProperties(dealId, dealPropertyPatch)
    if (!probResult.success) {
      console.error('deal property sync failed:', probResult.error)
    }

    if (result.quote) {
      setPublishedQuote({ ...result.quote, currency: dealCurrency })
      setQuoteError(null)
      toast.success('Quote published in HubSpot')
    } else {
      setQuoteError(result.quoteError ?? 'HubSpot did not accept the quote.')
    }
  }

  /** Resumes the quote from wherever it stopped. Never re-runs the deal writes:
   *  those succeeded, and repeating them would replace the line items again. */
  const handleRetryQuote = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      const result = await retryHubSpotQuote(dealId)
      if (result.success) {
        setPublishedQuote({ ...result.quote, currency: dealCurrency })
        setQuoteError(null)
        toast.success('Quote published in HubSpot')
      } else {
        setQuoteError(result.error)
        toast.error(result.error)
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Setup Dialog */}
      <Dialog open={showSetupDialog} onOpenChange={handleSetupOpenChange}>
        <DialogContent
          className="sm:max-w-[500px] bg-white text-gray-900 border-gray-200 shadow-xl"
          // X and Esc are deliberate exit gestures and now work. An overlay
          // click is usually an accident, and this dialog has four fields, so
          // that one stays blocked.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="text-xl font-bold uppercase tracking-wide text-gray-900">Quote Setup</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Distributor Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-gray-400" />
                Select sales team
              </Label>
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
                <Label className="text-gray-700 font-medium flex items-center gap-1.5">
                <Warehouse className="w-3.5 h-3.5 text-gray-400" />
                Sending Depot (optional)
              </Label>
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

                {/* Will Call sits with the depot because it is the same
                    decision: which depot, and does the customer come to it.
                    Copy mirrors the invoice editor's checkbox so the rep meets
                    the same words in both places. */}
                <label className="flex items-start gap-2 pt-1 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={isCollection}
                    onChange={(e) => setIsCollection(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  />
                  <span>
                    Collected by the customer (Will Call)
                    <span className="block text-xs text-gray-500">
                      Sales tax is charged at the collection depot, not at a delivery address.
                      Carried through to acceptance and the invoice.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {/* Template Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-gray-400" />
                Quote Template *
              </Label>
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
              <Label className="text-gray-700 font-medium flex items-center gap-1.5">
                <Percent className="w-3.5 h-3.5 text-gray-400" />
                Win Probability *
              </Label>
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

            {/* Rep agent. Optional, so it is deliberately absent from
                canProceedFromSetup: no rep should be blocked from quoting
                because an attribution field is unset. mode="defer" because
                createQuote's own property sync writes it, so a quote that
                fails leaves nothing behind on the deal. */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-gray-400" />
                {REP_AGENT_LABEL}
              </Label>
              <RepAgentSelect
                dealId={dealId}
                value={repAgent}
                canEdit
                mode="defer"
                onChange={setRepAgent}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => handleSetupOpenChange(false)}
              className="w-full min-h-11 whitespace-nowrap sm:min-h-0 sm:w-auto"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {hasCompletedSetup ? 'Close' : 'Back to deal'}
            </Button>
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

      {/* The customer's link is dead for as long as this quote sits in draft,
          so this is the loudest thing on the screen until it is republished. */}
      {editing && !submitted && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            Quote {editing.quoteNumber ?? ''} is recalled, and the link the customer has is offline right now.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            Make your changes and republish. It goes back out on the same link and keeps the same quote
            number, so there is nothing to resend. Leaving this page without republishing leaves the link
            offline.
          </p>
        </div>
      )}

      {/* Chosen setup, with a way back in — the dialog is otherwise one-way.
          Hidden on an edit: none of it can be changed on an existing quote. */}
      {!showSetupDialog && !editing && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
          <span>
            <span className="font-medium text-gray-900">
              {isDistributorSelected ? distributor : depot ? depotLabel(depot) : '—'}
            </span>{' '}
            · template {template || '—'} · {winProbability || '—'} to close
            {!isDistributorSelected && isCollection ? ' · Will Call' : ''}
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
                  <Button onClick={addLineItem} disabled={!selectedProduct} size="icon" aria-label="Add product" className="min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 bg-echo-yellow text-black hover:bg-echo-yellow/90">
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
                  {lineItems.map((item, index) => {
                    const result = pricedLines[index]
                    const priced = result?.ok ? result.lines[0] : null
                    const priceError = result && !result.ok ? result.error : null
                    // A SKU nobody has priced yet keeps the free price box, which
                    // is exactly today's behaviour. Everything else shows the
                    // resolved base and discounts from it.
                    const isManual = priced ? priced.priceSource === 'manual' : true
                    return (
                    <div key={index} className="p-4 bg-gray-50 rounded-lg border border-gray-100 space-y-3">
                      <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:gap-4">
                        <div className="col-span-2 max-sm:min-w-0 sm:flex-1">
                          <p className="font-medium text-gray-900 break-words">{item.name}</p>
                          <p className="text-xs text-gray-500">
                            SKU: {item.sku || 'N/A'}
                            {/* The customer's own code for this product, shown
                                only when their contract gave us one. It is what
                                appears on their purchase order, so it is the
                                fastest thing for a rep to check the line
                                against. Nothing else internal belongs here: no
                                Xero code, no depot, no company id. */}
                            {priced?.customerPartNumber && (
                              <span className="ml-2 text-gray-600">
                                Their code: {priced.customerPartNumber}
                              </span>
                            )}
                            {priced && (
                              <span
                                className={
                                  priced.priceSource === 'contract'
                                    ? 'ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-800'
                                    : priced.priceSource === 'list'
                                      ? 'ml-2 rounded bg-green-100 px-1.5 py-0.5 text-green-800'
                                      : 'ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800'
                                }
                              >
                                {priced.priceSource === 'contract'
                                  ? `Contract price${pricing?.contractorName ? `: ${pricing.contractorName}` : ''}`
                                  : priced.priceSource === 'list'
                                    ? 'List price'
                                    : 'No list price, you set it'}
                              </span>
                            )}
                          </p>
                        </div>

                        <div className="max-sm:min-w-0 sm:w-24">
                          <Label className="text-xs text-gray-500">Qty</Label>
                          <Input
                            inputMode="numeric"
                            aria-label="Quantity"
                            value={item.quantity}
                            onChange={(e) => updateLineItem(index, 'quantity', e.target.value)}
                            onBlur={(e) => {
                              // Tidy on the way OUT, never mid-edit. Blank
                              // becomes 1 so a line cannot submit empty, and a
                              // number is re-rendered from Number() so "0200"
                              // reads back as 200. Nothing is truncated: 1.5
                              // stays and validateLineItems refuses it.
                              const raw = e.target.value.trim()
                              if (raw === '') updateLineItem(index, 'quantity', '1')
                              else if (Number.isFinite(Number(raw))) {
                                updateLineItem(index, 'quantity', String(Number(raw)))
                              }
                            }}
                            className="h-11 sm:h-8 tabular-nums"
                          />
                        </div>

                        <div className="max-sm:min-w-0 sm:w-32">
                          <Label className="text-xs text-gray-500">{isManual ? 'Price' : 'List price'}</Label>
                          {isManual ? (
                            <Input
                              inputMode="decimal"
                              aria-label="Unit price"
                              placeholder="0.00"
                              value={item.unitPrice}
                              onChange={(e) => updateLineItem(index, 'unitPrice', e.target.value)}
                              className="h-11 sm:h-8 tabular-nums"
                            />
                          ) : (
                            <p className="pt-1 font-mono text-gray-500 line-through decoration-gray-300">
                              {money.format(priced?.priced.listUnitPrice ?? 0)}
                            </p>
                          )}
                        </div>

                        {!isManual && (
                          <div className="max-sm:min-w-0 sm:w-36">
                            <Label className="text-xs text-gray-500">Discount</Label>
                            <div className="flex gap-1">
                              <Input
                                inputMode="decimal"
                                aria-label="Discount"
                                value={item.discountValue ?? ''}
                                placeholder="0"
                                onChange={(e) => updateLineItemDiscount(index, { value: e.target.value })}
                                className="h-11 sm:h-8 tabular-nums"
                              />
                              <select
                                aria-label="Discount type"
                                value={item.discountMode ?? 'percent'}
                                onChange={(e) => updateLineItemDiscount(index, { mode: e.target.value as DiscountMode })}
                                className="h-11 sm:h-8 rounded border border-gray-300 bg-white px-1 text-sm text-gray-900"
                              >
                                <option value="percent">%</option>
                                <option value="amount">{money.format(0).replace(/[\d.,\s]/g, '') || '$'}</option>
                              </select>
                            </div>
                          </div>
                        )}

                        <div className="sm:w-24 text-left sm:text-right">
                          <Label className="text-xs text-gray-500">Unit</Label>
                          <p className="font-mono font-medium pt-1">
                            {money.format(priced?.priced.netUnitPrice ?? numericLines[index].unitPrice)}
                          </p>
                        </div>

                        <div className="sm:w-24 text-left sm:text-right">
                          <Label className="text-xs text-gray-500">Total</Label>
                          <p className="font-mono font-medium pt-1">
                            {money.format(priced?.lineTotal ?? 0)}
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

                      {priceError && (
                        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                          {priceError}
                        </p>
                      )}

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
                    )
                  })}

                  {/* What this rep is allowed to do, stated once under the cart
                      rather than repeated on every row. */}
                  <p className="text-xs text-gray-500">
                    {pricing?.isSuperAdmin
                      ? 'You can discount without a limit.'
                      : describeCap(pricing?.cap, dealCurrency)}
                  </p>
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
                {/* An edit never chose a template, and cannot: the template
                    association is fixed at creation. Show what the edit IS
                    keeping instead of an empty row. */}
                {editing ? (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">Quote number</span>
                    <span className="font-medium text-gray-900 text-right">
                      {editing.quoteNumber ?? 'unchanged'}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">Template</span>
                    <span className="font-medium text-gray-900 text-right">{template}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-between items-end mb-6">
                <span className="text-gray-500 font-medium">Grand Total</span>
                <span className="text-2xl font-bold text-gray-900">
                  {money.format(calculateGrandTotal())}
                </span>
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  onClick={generate}
                  disabled={lineItems.length === 0 || submitting || submitted || hasInvalidLineItems}
                  className="w-full bg-echo-yellow text-white hover:bg-[#4a5e29] font-bold min-h-12 sm:h-12 max-sm:text-base"
                >
                  <Send className="w-5 h-5 mr-2" />
                  {submitting
                    ? editing
                      ? 'Republishing...'
                      : 'Publishing...'
                    : submitted
                      ? editing
                        ? 'Quote republished'
                        : 'Quote published'
                      : editing
                        ? 'Republish quote on the same link'
                        : 'Publish quote in HubSpot'}
                </Button>
                {hasInvalidLineItems && !submitted && (
                  <p className="text-xs text-red-600 text-center">
                    {lineItemsError ?? 'Fix line item quantities (at least 1) and prices (0 or more) to generate.'}
                  </p>
                )}
                {publishedQuote ? (
                  <QuotePublishedPanel
                    quote={publishedQuote}
                    email={{
                      contactFirstName: contact?.properties.firstname,
                      contactEmail: contact?.properties.email,
                      companyName,
                      dealName,
                      repName: salesRep.name,
                      repPhone: salesRep.phone,
                      repEmail: salesRep.email,
                    }}
                  />
                ) : quoteError ? (
                  <QuoteFailedPanel error={quoteError} onRetry={handleRetryQuote} retrying={retrying} />
                ) : submitted ? (
                  <p className="text-xs text-gray-500 text-center">Publishing the quote in HubSpot...</p>
                ) : (
                  <p className="text-xs text-gray-500 text-center">
                    Moves the deal to Quotation sent, replaces its line items and publishes a HubSpot
                    quote. Does not email the customer.
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