'use client'

import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
  quantity: number
  unitPrice: number
  total: number
}

interface QuoteContact {
  properties: {
    firstname?: string
    lastname?: string
    jobtitle?: string
  }
}

interface HubSpotLineItem {
  properties: {
    hs_product_id?: string
    name?: string
    hs_sku?: string
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
  salesRep: { name: string; email: string }
  contact: QuoteContact | null
  initialLineItems?: HubSpotLineItem[]
}

const mapInitialLineItems = (items: HubSpotLineItem[]): LineItem[] =>
  items.map((item) => ({
    productId: item.properties.hs_product_id ?? '',
    name: item.properties.name ?? '',
    sku: item.properties.hs_sku,
    quantity: Number(item.properties.quantity) || 0,
    unitPrice: Number(item.properties.price) || 0,
    total: Number(item.properties.amount) || 0,
  }))

export default function CreateQuoteForm({ dealId, dealName, settings, products, salesRep, contact, initialLineItems = [] }: CreateQuoteFormProps) {
  // State for the Initial Setup Dialog
  const [showSetupDialog, setShowSetupDialog] = useState(true)
  const [distributor, setDistributor] = useState<string>('none')
  const [depot, setDepot] = useState<string>('')
  const [template, setTemplate] = useState<string>('')
  const [winProbability, setWinProbability] = useState<string>('')
  const [winProbabilityOptions, setWinProbabilityOptions] = useState<{ label: string; value: string }[]>([])
  const [setupLoading, setSetupLoading] = useState(false)

  // State for Quote Builder
  const [lineItems, setLineItems] = useState<LineItem[]>(() => mapInitialLineItems(initialLineItems))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [selectedProduct, setSelectedProduct] = useState<string>('')
  const [productSearch, setProductSearch] = useState('')
  const [filteredProducts, setFilteredProducts] = useState<Product[]>(products)
  const [allowedSkusForDepot, setAllowedSkusForDepot] = useState<string[]>([])

  useEffect(() => {
    async function fetchWinProbability() {
      const result = await getWinProbabilityOptions()
      if (result.success && result.data) {
        setWinProbabilityOptions(result.data)
      }
    }
    fetchWinProbability()
  }, [])

  // Fetch allowed SKUs when depot changes (or on initial load if depot is set)
  useEffect(() => {
    async function fetchSkus() {
      if (depot) {
        const result = await getMappedSkus(depot)
        setAllowedSkusForDepot(result.data || [])
      } else {
        setAllowedSkusForDepot([])
      }
    }
    fetchSkus()
  }, [depot])

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
  const canProceedFromSetup = (isDistributorSelected || depot !== '') && template !== '' && winProbability !== ''

  const handleSetupComplete = async () => {
    if (!canProceedFromSetup) return
    setSetupLoading(true)
    const result = await updateDealProperties(dealId, { win_probability: winProbability })
    setSetupLoading(false)
    if (!result.success) {
      toast.error('Failed to save win probability: ' + result.error)
      return
    }
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
    
    if (field === 'quantity') {
      item.quantity = value
      item.total = item.quantity * item.unitPrice
    } else if (field === 'unitPrice') {
      item.unitPrice = value
      item.total = item.quantity * item.unitPrice
    }

    setLineItems(newItems)
  }

  const removeLineItem = (index: number) => {
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  const calculateGrandTotal = () => {
    const sum = lineItems.reduce((acc, item) => acc + (Number(item.total) || 0), 0)
    return Math.round(sum * 100) / 100
  }

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
        depot: depot || 'N/A',
        template,
        lineItems,
        totalAmount: calculateGrandTotal(),
        winProbability, // backbone: persisted to deals_registry.deal_probability
        isPreview: false
      })

      if (!result.success) {
        toast.error('Failed to save quote: ' + result.error)
        return
      }

      quoteRef = result.quoteReference || 'DRAFT'
    } else {
      // Preview Mode: Just generate PDF, don't call server action
      quoteRef = 'PREVIEW'
    }

    // 2. Generate PDF Content (dynamically imported to keep them out of the initial bundle)
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()

    // --- Header Section ---
    // Logo (Placeholder - ideally load base64 image)
    doc.setFontSize(24)
    doc.setTextColor(85, 107, 47) // Olive Green (RAL 6003)
    doc.setFont("helvetica", "bold")
    doc.text('ECHO BARRIER', 14, 20)
    doc.setFontSize(10)
    doc.text('Environmentally Sound', 14, 25)

    // Title
    doc.setFontSize(22)
    doc.setTextColor(0, 0, 0)
    doc.text(dealName, 14, 45)
    // doc.text('Order #2', 14, 55) // Optional: Add order number if available

    // Meta Info
    doc.setFontSize(10)
    doc.setTextColor(100, 100, 100)
    doc.setFont("helvetica", "normal")
    doc.text(`Quote created: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}   Reference: ${quoteRef}`, 14, 65)

    // Sales Rep Info (Right Aligned)
    const pageWidth = doc.internal.pageSize.width
    doc.setFont("helvetica", "bold")
    doc.setTextColor(0, 0, 0)
    doc.text(salesRep.name, pageWidth - 14, 75, { align: 'right' })
    doc.setFont("helvetica", "normal")
    doc.text(salesRep.email, pageWidth - 14, 80, { align: 'right' })

    // Comments Box (Gray Background)
    doc.setFillColor(240, 240, 240)
    doc.rect(14, 90, pageWidth - 28, 30, 'F')
    
    doc.setFont("helvetica", "bold")
    doc.text('Comments', pageWidth / 2, 95, { align: 'center' })
    
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.text('4- day shipping via FedEx', 20, 105)
    doc.text(`Shipping from ${depot || 'Depot'}`, 20, 110)

    // Contact Person (Bottom Right of Comments)
    if (contact) {
      doc.text(`${contact.properties.firstname} ${contact.properties.lastname} - ${contact.properties.jobtitle || 'Client'}`, pageWidth - 20, 115, { align: 'right' })
    }

    // --- Products & Services Section ---
    doc.setFontSize(18)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(40, 55, 75) // Dark Blue/Gray
    doc.text('Products & Services', pageWidth / 2, 140, { align: 'center' })

    // Table
    const tableColumn = ["Item & Description", "SKU", "Quantity", "Unit Price", "Total"]
    const tableRows = lineItems.map(item => [
      `${item.name}\n4' x 6' SOUND REDUCTING BARRIER; FIRE, UV,\nand WATER RESISTENT`, // Mock description
      item.sku || 'N/A',
      item.quantity,
      item.unitPrice.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
      item.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    ])

    // Add Freight Line Item (Mock)
    // Only add if not already in line items
    // tableRows.push([
    //   "LTL Freight\nLTL",
    //   "LTLNA",
    //   1,
    //   "$550.00",
    //   "$550.00"
    // ])

    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 150,
      theme: 'plain',
      headStyles: { 
        fillColor: [255, 255, 255], 
        textColor: [85, 107, 47], // Olive Green
        fontStyle: 'bold',
        fontSize: 10,
        halign: 'left'
      },
      bodyStyles: {
        textColor: [80, 80, 80],
        fontSize: 10,
        cellPadding: 6
      },
      columnStyles: {
        0: { cellWidth: 80 }, // Description column wider
        3: { halign: 'right' },
        4: { halign: 'right' }
      },
      didDrawCell: (data) => {
        // Add horizontal lines only (custom styling to match screenshot)
        if (data.section === 'head' || data.section === 'body') {
           doc.setDrawColor(230, 230, 230);
           doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
        }
      }
    })

    // Totals Section
    const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY || 150
    const grandTotal = calculateGrandTotal()
    
    doc.setFontSize(10)
    doc.setTextColor(80, 80, 80)
    doc.text('One-time subtotal', pageWidth - 60, finalY + 15)
    doc.text(grandTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD' }), pageWidth - 14, finalY + 15, { align: 'right' })
    
    doc.setFontSize(11)
    doc.setTextColor(40, 55, 75)
    doc.text('Total', pageWidth - 60, finalY + 25)
    doc.text(grandTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD' }), pageWidth - 14, finalY + 25, { align: 'right' })

    // Dotted lines for totals
    doc.setDrawColor(200, 200, 200);
    (doc as unknown as { setLineDash: (segments: number[], phase: number) => void }).setLineDash([1, 1], 0);
    doc.line(pageWidth - 60, finalY + 17, pageWidth - 14, finalY + 17);
    doc.line(pageWidth - 60, finalY + 27, pageWidth - 14, finalY + 27);

    // --- Page 2: Terms & Contact ---
    doc.addPage()
    
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.setFont("helvetica", "bold")
    doc.text(`This quote expires on ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, pageWidth / 2, 20, { align: 'center' })

    // Purchase Terms Box
    doc.setFillColor(248, 248, 248)
    doc.rect(14, 30, pageWidth - 28, 80, 'F')
    
    doc.setFontSize(11)
    doc.setTextColor(40, 55, 75)
    doc.text('Purchase terms', pageWidth / 2, 45, { align: 'center' })
    
    doc.setFontSize(9)
    doc.setTextColor(80, 80, 80)
    doc.setFont("helvetica", "normal")
    const termsText = "We trust that our quotation meets your requirements and look forward to receiving your written confirmation and/or purchase order by return. Please note that under no circumstances can we proceed with an order without written confirmation from the client. In the meantime, if you require any further assistance, please do not hesitate to contact our office.\n\nIn the event of an order we would be grateful if you would refer to the quotation number shown above. Many thanks for your ongoing support of our Echo Barrier product line.\n\nYours sincerely,"
    doc.text(termsText, 20, 60, { maxWidth: pageWidth - 40, align: 'justify' })

    // Contact Me Box
    doc.setFillColor(230, 230, 230)
    doc.rect(14, 120, pageWidth - 28, 140, 'F')

    doc.setFontSize(24)
    doc.setTextColor(0, 0, 0)
    doc.setFont("helvetica", "bold")
    doc.text('Questions? Contact me', pageWidth / 2, 140, { align: 'center' })

    doc.setFontSize(10)
    doc.text(salesRep.name, pageWidth / 2, 155, { align: 'center' })
    doc.text('Sales Representative', pageWidth / 2, 160, { align: 'center' })

    doc.setFont("helvetica", "normal")
    doc.text(salesRep.email, pageWidth / 2, 175, { align: 'center' })
    doc.setFont("helvetica", "bold")
    // doc.text('Cell : 312 278 5759', pageWidth / 2, 185, { align: 'center' }) // TODO: Add phone to profile
    doc.text('Office+1 (800) 728 9098', pageWidth / 2, 195, { align: 'center' })

    doc.setFont("helvetica", "normal")
    doc.text('Echo Barrier USA LLC', pageWidth / 2, 215, { align: 'center' })
    doc.text('33 North Dearborn', pageWidth / 2, 225, { align: 'center' })
    doc.text('Suite 1000', pageWidth / 2, 235, { align: 'center' })
    doc.text('Chicago 60602', pageWidth / 2, 245, { align: 'center' })
    doc.text('IL', pageWidth / 2, 255, { align: 'center' })

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
      const formData = new FormData()
      formData.append('file', pdfBlob, `quote_${quoteRef}.pdf`)
      formData.append('dealId', dealId)

      const uploadResult = await handleQuoteFileUpload(formData)
      if (uploadResult.success) {
        // Redirect to HubSpot Deal Record in new tab
        // Note: Using the portal ID from env or default
        const portalId = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
        if (portalId) {
          window.open(`https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`, '_blank')
        }
      } else {
        console.error('Failed to upload PDF:', uploadResult.error)
        toast.error('Quote saved but failed to upload to HubSpot: ' + uploadResult.error)
      }
    }
  }

  return (
    <div className="space-y-8">
      {/* Setup Dialog */}
      <Dialog open={showSetupDialog} onOpenChange={setShowSetupDialog}>
        <DialogContent className="sm:max-w-[500px] bg-white text-gray-900 border-gray-200 shadow-xl" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold uppercase tracking-wide text-gray-900">Quote Setup</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Distributor Selection */}
            <div className="space-y-2">
              <Label className="text-gray-700 font-medium">Assign to Distributor?</Label>
              <Select value={distributor} onValueChange={setDistributor}>
                <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow focus:border-echo-yellow">
                  <SelectValue placeholder="Select Distributor (Optional)" />
                </SelectTrigger>
                <SelectContent className="bg-white border-gray-200 text-gray-900">
                  <SelectItem value="none" className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">No Distributor (Direct Sale)</SelectItem>
                  {settings.allowed_distributors.map((dist) => (
                    <SelectItem key={dist} value={dist} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{dist}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isDistributorSelected && (
                <p className="text-xs text-blue-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Deal will be moved to &quot;Distributor&quot; stage automatically.
                </p>
              )}
            </div>

            {/* Depot Selection (Only if no distributor) */}
            {!isDistributorSelected && (
              <div className="space-y-2">
                <Label className="text-red-600 font-medium">Select Sending Depot *</Label>
                <Select value={depot} onValueChange={setDepot}>
                  <SelectTrigger className="bg-white border-red-200 text-gray-900 focus:ring-red-500">
                    <SelectValue placeholder="Choose Depot..." />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-gray-200 text-gray-900">
                    {settings.allowed_depots.map((d) => (
                      <SelectItem key={d} value={d} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                      <SelectItem key={t} value={t} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{t}</SelectItem>
                    ))
                  ) : (
                    <SelectItem value="default" className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">Standard Quote Template</SelectItem>
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
                    <SelectItem key={opt.value} value={opt.value} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
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
              className="w-full bg-echo-yellow text-black hover:bg-echo-yellow/90"
            >
              {setupLoading ? 'Saving...' : <>Start Quote <ArrowRight className="w-4 h-4 ml-2" /></>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Main Quote Builder UI */}
      {!showSetupDialog && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left: Line Items */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="p-6 bg-white border-gray-200">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold text-gray-900">Line Items</h2>
                <div className="flex gap-2 items-center">
                  <div className="relative w-[300px]">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                    <Input 
                      placeholder="Search products..." 
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="pl-8 h-10 bg-white border-gray-300 text-gray-900"
                    />
                  </div>
                  <Select value={selectedProduct} onValueChange={setSelectedProduct}>
                    <SelectTrigger className="w-[250px] bg-white border-gray-300 text-gray-900">
                      <SelectValue placeholder="Select Product..." />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-gray-200 text-gray-900 max-h-[300px]">
                      {filteredProducts.length > 0 ? (
                        filteredProducts.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                            {p.properties.name} ({Number(p.properties.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})
                          </SelectItem>
                        ))
                      ) : (
                        <div className="p-2 text-sm text-gray-500 text-center">No products found</div>
                      )}
                    </SelectContent>
                  </Select>
                  <Button onClick={addLineItem} disabled={!selectedProduct} size="icon" className="bg-echo-yellow text-black hover:bg-echo-yellow/90">
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
                    <div key={index} className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                      <div className="flex-1">
                        <p className="font-medium text-gray-900">{item.name}</p>
                        <p className="text-xs text-gray-500">SKU: {item.sku || 'N/A'}</p>
                      </div>
                      
                      <div className="w-24">
                        <Label className="text-xs text-gray-500">Qty</Label>
                        <Input 
                          type="number" 
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(index, 'quantity', parseInt(e.target.value) || 0)}
                          className="h-8"
                        />
                      </div>

                      <div className="w-32">
                        <Label className="text-xs text-gray-500">Price</Label>
                        <Input 
                          type="number" 
                          min="0"
                          step="0.01"
                          value={item.unitPrice}
                          onChange={(e) => updateLineItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                          className="h-8"
                        />
                      </div>

                      <div className="w-24 text-right">
                        <Label className="text-xs text-gray-500">Total</Label>
                        <p className="font-mono font-medium pt-1">
                          {item.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                        </p>
                      </div>

                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={() => removeLineItem(index)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* Right: Summary & Actions */}
          <div className="space-y-6">
            <Card className="p-6 bg-white border-gray-200 sticky top-24">
              <h3 className="text-lg font-bold text-gray-900 mb-4">Quote Summary</h3>
              
              <div className="space-y-3 text-sm border-b border-gray-100 pb-4 mb-4">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Distributor</span>
                  <span className="font-medium text-gray-900 text-right">{isDistributorSelected ? distributor : 'Direct Sale'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Depot</span>
                  <span className="font-medium text-gray-900 text-right">{depot || 'N/A'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Template</span>
                  <span className="font-medium text-gray-900 text-right">{template}</span>
                </div>
              </div>

              <div className="flex justify-between items-end mb-6">
                <span className="text-gray-500 font-medium">Grand Total</span>
                <span className="text-2xl font-bold text-gray-900">
                  {calculateGrandTotal().toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                </span>
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  onClick={() => generatePDF(true)}
                  disabled={lineItems.length === 0 || submitting}
                  variant="outline"
                  className="w-full border-gray-300 text-gray-700 hover:bg-gray-50 font-bold h-12 text-lg"
                >
                  <Eye className="w-5 h-5 mr-2" />
                  Preview Quote
                </Button>

                <Button
                  onClick={() => generatePDF(false)}
                  disabled={lineItems.length === 0 || submitting}
                  className="w-full bg-echo-yellow text-white hover:bg-[#4a5e29] font-bold h-12 text-lg"
                >
                  <FileDown className="w-5 h-5 mr-2" />
                  {submitting ? 'Generating...' : 'Generate & Send Quote'}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}