'use client'

/**
 * Draft-invoice editor: the union of Xero's invoice fields and TaxJar's
 * inputs, every field present and editable even when empty. Per-line ship-from
 * depot drives the grouped TaxJar calculation; fitting-kit components stay
 * pinned to Baltimore. Buttons follow the product rule: every submit shows a
 * pending state and is disabled while in flight.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, Lock, MapPin, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { US_STATES, DELIVERY_COUNTRIES } from '@/lib/us-address'
import { saveDeliveryAddress } from '@/app/actions/invoicing/delivery-addresses'
import {
  deliveryAddressLabel,
  isSaveableDeliveryAddress,
  type SavedDeliveryAddress,
} from '@/lib/customer-invoice/delivery-address-book'
import { lookupZipJurisdiction } from '@/app/actions/tax/lookup-zip'
import { getXeroItemAccounts, saveInvoiceCoding } from '@/app/actions/invoicing/save-coding'
import {
  US_DEPOTS,
  DEPOT_FROM_ADDRESSES,
  type CustomerInvoiceStatus,
  type USDepot,
} from '@/lib/customer-invoice/constants'
import { computeDraftLineTotal } from '@/lib/customer-invoice/build-draft'
import { TaxDetail } from './tax-detail'
import { getTrackingCategories } from '@/app/actions/invoicing/tracking-categories'
import {
  parseLineTracking,
  setLineTracking,
  type LineTracking,
  type TrackingCategory,
} from '@/lib/customer-invoice/tracking'
import { roundCents } from '@/lib/quote-math'
import type { CustomerInvoiceLineRow, CustomerInvoiceRow } from '@/app/actions/invoicing/shared'
import { saveInvoiceDraft } from '@/app/actions/invoicing/save-draft'
import { calculateInvoiceTax } from '@/app/actions/invoicing/calculate-tax'
import { sendInvoiceToXero } from '@/app/actions/invoicing/send-to-xero'
import { XeroContactCard } from './xero-contact-card'
import { depotLabel } from '@/lib/depot-constants'
import { voidInvoice } from '@/app/actions/invoicing/void-invoice'
import { rebuildInvoiceFromDeal } from '@/app/actions/invoicing/rebuild-invoice'
import { sendOrderToTaxJar } from '@/app/actions/invoicing/record-taxjar'
import { previewInvoicePdf } from '@/app/actions/invoicing/preview-invoice'
import { generateInvoicePdf } from '@/app/actions/invoicing/generate-invoice-pdf'
import { emailInvoiceToCustomer } from '@/app/actions/invoicing/email-invoice'
import { reconcileStuckInvoice } from '@/app/actions/invoicing/reset-authorizing'
import { InvoiceStatusChip } from '../status-chip'

/** One <datalist> serves every row's item-code field. Per-row lists would put
 *  a copy of Xero's whole catalogue in the DOM for each line. */
const ITEM_CODE_LIST_ID = 'xero-item-codes'

interface EditableLine {
  line_key: string
  origin: 'hubspot' | 'kit_split' | 'manual'
  parent_line_key: string | null
  hs_line_item_id: string | null
  hs_product_id: string | null
  sku: string
  xero_item_code: string
  account_code: string
  name: string
  description: string
  quantity: string
  unit_price: string
  discount_percentage: string
  is_shipping: boolean
  ship_from_depot: 'US-BAL' | 'US-SBD'
  ship_from_locked: boolean
  tax_amount: string
  tax_override: boolean
  tracking: LineTracking[]
}

interface InvoiceEditorProps {
  invoice: CustomerInvoiceRow
  lines: CustomerInvoiceLineRow[]
  dealName: string
  quoteReference: string | null
  linesChanged: boolean
  canManage: boolean
  /** Ship-to addresses already used for this customer, newest first. Empty when
   *  the invoice has neither a Xero account code nor a HubSpot company, in
   *  which case the picker hides and manual entry is all there is. */
  savedAddresses: SavedDeliveryAddress[]
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

function toEditable(line: CustomerInvoiceLineRow): EditableLine {
  return {
    line_key: line.line_key,
    origin: line.origin,
    parent_line_key: line.parent_line_key,
    hs_line_item_id: line.hs_line_item_id,
    hs_product_id: line.hs_product_id,
    sku: line.sku ?? '',
    xero_item_code: line.xero_item_code ?? '',
    account_code: line.account_code ?? '',
    name: line.name,
    description: line.description ?? '',
    quantity: String(line.quantity ?? 0),
    unit_price: String(line.unit_price ?? 0),
    discount_percentage: String(line.discount_percentage ?? 0),
    is_shipping: line.is_shipping,
    ship_from_depot: line.ship_from_depot,
    ship_from_locked: line.ship_from_locked,
    tax_amount: line.tax_amount === null ? '' : String(line.tax_amount),
    tax_override: line.tax_override,
    tracking: parseLineTracking(line.tracking),
  }
}

export function InvoiceEditor({ invoice, lines, dealName, quoteReference, linesChanged, canManage, savedAddresses }: InvoiceEditorProps) {
  const router = useRouter()
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const [header, setHeader] = useState({
    invoice_date: invoice.invoice_date ?? '',
    due_date: invoice.due_date ?? '',
    customer_po_number: invoice.customer_po_number ?? '',
    taxjar_customer_id: invoice.taxjar_customer_id ?? '',
    delivery_street: invoice.delivery_street ?? '',
    delivery_city: invoice.delivery_city ?? '',
    delivery_state: invoice.delivery_state ?? '',
    delivery_zip: invoice.delivery_zip ?? '',
    delivery_location: invoice.delivery_location ?? '',
    delivery_requested_by: invoice.delivery_requested_by ?? '',
    is_collection: invoice.is_collection,
  })
  // The book, kept in state so a save shows up in the dropdown without a reload.
  const [addressBook, setAddressBook] = useState<SavedDeliveryAddress[]>(savedAddresses)
  const [addressNotice, setAddressNotice] = useState<string | null>(null)
  const [zipLookup, setZipLookup] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'ok'; place: string; state: string } | { status: 'error'; message: string }
  >({ status: 'idle' })
  /**
   * Fill the address fields from a remembered one.
   *
   * requested_by is filled too but is the field most likely to be wrong for a
   * new order, so it is the one the rep is most likely to overwrite. Filling it
   * still beats making them retype the common case.
   */
  const applySavedAddress = (id: string) => {
    const saved = addressBook.find((a) => a.id === id)
    if (!saved) return
    setHeader((current) => ({
      ...current,
      delivery_street: saved.street ?? '',
      delivery_city: saved.city ?? '',
      delivery_state: saved.state ?? '',
      delivery_zip: saved.zip ?? '',
      delivery_location: saved.location ?? '',
      delivery_requested_by: saved.requestedBy ?? '',
    }))
    setAddressNotice(null)
  }

  /** Remember the address currently typed in, for next time. */
  const rememberAddress = () => {
    const address = {
      street: header.delivery_street,
      city: header.delivery_city,
      state: header.delivery_state,
      zip: header.delivery_zip,
      location: header.delivery_location,
    }
    if (!isSaveableDeliveryAddress(address)) {
      setAddressNotice('Fill in the street, city, state and zip before saving the address.')
      return
    }
    setPendingAction('save-address')
    startTransition(async () => {
      const result = await saveDeliveryAddress({
        invoiceId: invoice.id,
        street: header.delivery_street,
        city: header.delivery_city,
        state: header.delivery_state,
        zip: header.delivery_zip,
        country: invoice.delivery_country || 'US',
        location: header.delivery_location.trim() || null,
        requestedBy: header.delivery_requested_by.trim() || null,
      })
      setPendingAction(null)
      if (!result.success) {
        setAddressNotice(result.error ?? 'The address could not be saved.')
        return
      }
      if (result.addresses) setAddressBook(result.addresses)
      setAddressNotice('Saved. It will be in the list next time.')
    })
  }

  const [rows, setRows] = useState<EditableLine[]>(lines.map(toEditable))
  // Read from Xero once per editor.
  //
  // The outcome is tracked, not just the list, because an empty list and a
  // failed call produce the SAME screen otherwise: the whole Tracking column
  // hides and the rep sees an editor identical to the one that existed before
  // tracking was built. A failure was logged to the console and nowhere else,
  // so a broken n8n route looked exactly like a feature that was never
  // shipped. On a healthy portal this fetch returns two active categories and
  // neither notice appears; the column is then the 8th of 11 and needs a
  // horizontal scroll to reach.
  const [trackingCategories, setTrackingCategories] = useState<TrackingCategory[]>([])
  const [trackingLoad, setTrackingLoad] = useState<'loading' | 'ok' | 'empty' | 'failed'>('loading')
  const [trackingError, setTrackingError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getTrackingCategories().then((result) => {
      if (cancelled) return
      if (result.success) {
        setTrackingCategories(result.categories)
        setTrackingLoad(result.categories.length > 0 ? 'ok' : 'empty')
      } else {
        setTrackingLoad('failed')
        setTrackingError(result.error)
        console.error('Tracking categories could not be loaded:', result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  // What TaxJar last returned per line, used to decide whether an edited tax
  // cell is genuinely a manual override.
  const calculatedTaxByKey = useMemo(
    () => new Map(lines.map((l) => [l.line_key, l.tax_amount === null ? '' : String(l.tax_amount)])),
    [lines],
  )
  const goodsDepots = useMemo(
    () => [...new Set(rows.filter((r) => !r.is_shipping).map((r) => r.ship_from_depot))],
    [rows],
  )
  const collectionDestinations = useMemo(
    () => goodsDepots.map((d) => DEPOT_FROM_ADDRESSES[d as USDepot]).filter((a) => a !== null && a !== undefined),
    [goodsDepots],
  )
  const unconfiguredCollectionDepots = useMemo(
    () => goodsDepots.filter((d) => !DEPOT_FROM_ADDRESSES[d as USDepot]),
    [goodsDepots],
  )

  const status = invoice.status as CustomerInvoiceStatus
  const editable = canManage && (status === 'draft' || status === 'tax_calculated')

  /**
   * The Xero CODING stays editable long after the rest of the invoice freezes.
   *
   * Dean's call: freezing at 'sent' protects the document the customer is
   * holding, but the item code and account code are not on that document. They
   * are absent from linesHash (so they cannot invalidate the tax or trip the
   * staleness guard) and absent from the PDF (so they cannot make the emailed
   * file disagree with the record). Until Send to Xero runs they have had no
   * effect on anything, and blocking them only forced a full rebuild to fix a
   * one-line mapping. Stops at 'completed', where Xero already used them.
   */
  const codingEditable =
    canManage && (status === 'draft' || status === 'tax_calculated' || status === 'filed' || status === 'documented' || status === 'sent')
  /** True once the normal Save button is gone, so coding needs its own save. */
  const codingNeedsOwnSave = codingEditable && !editable

  /**
   * Xero's item-to-account map, fetched once and reused.
   *
   * Dean: "it would be better if the account code automatically fetches and
   * syncs when you enter/reenter the Xero item code." One call brings back the
   * whole map (107 items live), so this is lazy on the first item-code edit
   * rather than on page load: an invoice nobody recodes should not pay a Xero
   * round trip to open.
   */
  const [itemAccounts, setItemAccounts] = useState<Record<string, string | null> | null>(null)
  const itemAccountsPromise = useRef<Promise<Record<string, string | null> | null> | null>(null)

  const loadItemAccounts = () => {
    if (itemAccountsPromise.current) return itemAccountsPromise.current
    const pending = getXeroItemAccounts()
      .then((result) => {
        if (!result.success) {
          // Not fatal. The field stays typeable, which is how it behaved
          // before, so a Xero outage cannot block coding an invoice by hand.
          toast.warning(`Could not read Xero's item list: ${result.error}`)
          itemAccountsPromise.current = null
          return null
        }
        setItemAccounts(result.accounts)
        return result.accounts
      })
      .catch(() => {
        itemAccountsPromise.current = null
        return null
      })
    itemAccountsPromise.current = pending
    return pending
  }

  /**
   * Resolve the account for a typed item code, on blur rather than per
   * keystroke: "H9BALT" passes through H, H9, H9B on the way in and none of
   * those should rewrite the account.
   *
   * The three outcomes are deliberately distinguished. A code Xero does not
   * have at all is usually the real problem (the `01-EBH9` case, a SKU that was
   * never a Xero item), and a code Xero has with NO account behind it is a
   * different problem that typing harder will not fix. Saying "not found" for
   * both is what made the original error hard to act on.
   */
  const syncAccountFromItemCode = async (lineKey: string, rawItemCode: string) => {
    const itemCode = rawItemCode.trim()
    if (!itemCode) return
    const accounts = itemAccounts ?? (await loadItemAccounts())
    if (!accounts) return

    if (!(itemCode in accounts)) {
      toast.warning(`Xero has no item called "${itemCode}", so no account could be filled in. Check the code.`)
      return
    }

    const account = accounts[itemCode]
    if (!account) {
      toast.warning(`Xero item "${itemCode}" has no sales account set against it, so the account must be typed by hand.`)
      return
    }

    setRows((current) => {
      const target = current.find((r) => r.line_key === lineKey)
      // Already correct, so say nothing: re-blurring a field should be silent.
      if (!target || target.account_code === account) return current
      toast.success(`Account ${account} filled in from ${itemCode}.`)
      return current.map((r) => (r.line_key === lineKey ? { ...r, account_code: account } : r))
    })
  }

  /** Whether the coding on screen differs from what is stored, so the save
   *  button only appears when there is something to save. */
  const codingDirty = useMemo(() => {
    const stored = new Map(
      lines.map((l) => [l.line_key, `${l.xero_item_code ?? ''}|${l.account_code ?? ''}`]),
    )
    return rows.some(
      (row) => stored.get(row.line_key) !== `${row.xero_item_code.trim()}|${row.account_code.trim()}`,
    )
  }, [rows, lines])

  /** Persist just the two Xero coding columns, for a frozen invoice. */
  const onSaveCoding = () =>
    run('coding', async () => {
      const result = await saveInvoiceCoding({
        invoiceId: invoice.id,
        lines: rows.map((row) => ({
          line_key: row.line_key,
          xero_item_code: row.xero_item_code.trim() || null,
          account_code: row.account_code.trim() || null,
        })),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Xero codes saved.')
      router.refresh()
    })
  // Only the end of the line is terminal now. 'sent' means the customer has the
  // document but Xero has not been told yet, so it still has a button.
  const terminal = status === 'completed' || status === 'authorizing'

  // What TaxJar actually decided, per ship-from depot. The handover is explicit
  // that the reviewer must see the resolved JURISDICTION and not just the rate:
  // a wrong zip returns a different number with no error, so the place is the
  // check. Read from the stored response, never recomputed here.
  const taxGroups = useMemo(() => {
    const raw = invoice.taxjar_response
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      const e = entry as {
        depot?: string
        response?: {
          tax?: {
            rate?: number
            has_nexus?: boolean
            freight_taxable?: boolean
            tax_source?: string
            amount_to_collect?: number
            jurisdictions?: { state?: string; county?: string; city?: string }
          }
        }
      }
      const tax = e.response?.tax
      if (!e.depot || !tax) return []
      const j = tax.jurisdictions ?? {}
      const titled = (v?: string) =>
        v ? v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null
      return [{
        depot: e.depot,
        from: DEPOT_FROM_ADDRESSES[e.depot as USDepot] ?? null,
        place: [titled(j.city), titled(j.county), j.state].filter(Boolean).join(', ') || 'not returned',
        rate: typeof tax.rate === 'number' ? tax.rate : null,
        collected: typeof tax.amount_to_collect === 'number' ? tax.amount_to_collect : null,
        hasNexus: tax.has_nexus !== false,
        freightTaxable: tax.freight_taxable === true,
        source: tax.tax_source ?? null,
      }]
    })
  }, [invoice.taxjar_response])

  const totals = useMemo(() => {
    let subtotal = 0
    let shipping = 0
    let tax = 0
    let taxKnown = true
    for (const row of rows) {
      const lineTotal = computeDraftLineTotal(Number(row.quantity) || 0, Number(row.unit_price) || 0, Number(row.discount_percentage) || 0)
      if (row.is_shipping) shipping += lineTotal
      else subtotal += lineTotal
      if (row.tax_amount === '') taxKnown = false
      else tax += Number(row.tax_amount) || 0
    }
    return {
      subtotal: roundCents(subtotal),
      shipping: roundCents(shipping),
      tax: taxKnown && status !== 'draft' ? roundCents(tax) : null,
    }
  }, [rows, status])

  const updateRow = (key: string, patch: Partial<EditableLine>) => {
    setRows((current) => current.map((row) => (row.line_key === key ? { ...row, ...patch } : row)))
  }

  const addLine = () => {
    const n = rows.length + 1
    setRows((current) => [
      ...current,
      {
        line_key: `M${Date.now().toString(36)}-${n}`,
        origin: 'manual',
        parent_line_key: null,
        hs_line_item_id: null,
        hs_product_id: null,
        sku: '',
        xero_item_code: '',
        account_code: '',
        name: '',
        description: '',
        quantity: '1',
        unit_price: '0',
        discount_percentage: '0',
        is_shipping: false,
        ship_from_depot: 'US-BAL',
        ship_from_locked: false,
        tax_amount: '',
        tax_override: false,
        tracking: [],
      },
    ])
  }

  const removeLine = (key: string) => {
    setRows((current) => current.filter((row) => row.line_key !== key))
  }

  const run = (name: string, fn: () => Promise<void>) => {
    setPendingAction(name)
    startTransition(async () => {
      try {
        await fn()
      } finally {
        setPendingAction(null)
      }
    })
  }

  const resolveZip = async (raw: string) => {
    const value = raw.trim()
    if (!/^\d{5}(-\d{4})?$/.test(value)) {
      setZipLookup({ status: 'idle' })
      return
    }
    setZipLookup({ status: 'loading' })
    const result = await lookupZipJurisdiction({ zip: value })
    if (!result.success) {
      setZipLookup({ status: 'error', message: result.error })
      return
    }
    const place = [result.city, result.county && `${result.county} County`, result.state].filter(Boolean).join(', ')
    setZipLookup({ status: 'ok', place, state: result.state })
    // Fill blanks only. Never overwrite a reviewer's own entry: a zip can
    // straddle jurisdictions and the street decides which one.
    setHeader((current) => ({
      ...current,
      delivery_state: current.delivery_state || result.state,
      delivery_city: current.delivery_city || result.city || '',
    }))
  }

  const buildSavePayload = () => ({
    invoiceId: invoice.id,
    header: {
      invoice_date: header.invoice_date || null,
      due_date: header.due_date || null,
      customer_po_number: header.customer_po_number || null,
      taxjar_customer_id: header.taxjar_customer_id || null,
      delivery_street: header.delivery_street || null,
      delivery_city: header.delivery_city || null,
      delivery_state: header.delivery_state || null,
      delivery_zip: header.delivery_zip || null,
      delivery_location: header.delivery_location.trim() || null,
      delivery_requested_by: header.delivery_requested_by.trim() || null,
      is_collection: header.is_collection,
    },
    lines: rows.map((row, index) => ({
      line_key: row.line_key,
      sort_order: index,
      origin: row.origin,
      parent_line_key: row.parent_line_key,
      hs_line_item_id: row.hs_line_item_id,
      hs_product_id: row.hs_product_id,
      sku: row.sku || null,
      account_code: row.account_code || null,
      xero_item_code: row.xero_item_code || null,
      name: row.name || 'Line item',
      description: row.description || null,
      quantity: Number(row.quantity) || 0,
      unit_price: Number(row.unit_price) || 0,
      discount_percentage: Number(row.discount_percentage) || 0,
      is_shipping: row.is_shipping,
      ship_from_depot: row.ship_from_depot,
      tracking: row.tracking,
      tax_amount_override:
        row.tax_override && row.tax_amount !== '' && row.tax_amount !== calculatedTaxByKey.get(row.line_key)
          ? Number(row.tax_amount) || 0
          : null,
    })),
  })

  // Saving IS the calculate step. TaxJar's /v2/taxes call is a read-only quote:
  // it files nothing and costs nothing to repeat, so there is no reason to make
  // Dave press a second button to see the tax. The ORDER TRANSACTION, which is
  // the actual filing record, is created only by Send to TaxJar.
  const onSave = () =>
    run('save', async () => {
      const saved = await saveInvoiceDraft(buildSavePayload())
      if (!saved.success) {
        toast.error(saved.error)
        return
      }
      const result = await calculateInvoiceTax({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        router.refresh()
        return
      }
      for (const warning of result.warnings) toast.warning(warning, { duration: 10000 })
      toast.success(`Saved. Tax ${money.format(result.taxTotal)}, total ${money.format(result.total)}.`)
      router.refresh()
    })

  const onSend = () =>
    run('send', async () => {
      // NOT save-first. That was right when Xero was the step straight after
      // Save draft and the row could still hold unsaved edits. Xero is now
      // LAST, reachable only once the invoice has passed through Send to
      // TaxJar and Generate and Email, all of which require status
      // 'tax_calculated' or later, at which point editable is already false
      // and the row IS the frozen source of truth the PDF was hashed from.
      //
      // Calling saveInvoiceDraft here doesn't just do nothing: it actively
      // breaks the button. Its own guard rejects any status other than
      // 'draft' or 'tax_calculated', and this button is only shown at
      // 'sent', so every call failed with "This invoice is sent and can no
      // longer be edited" before sendInvoiceToXero was ever reached. n8n
      // never saw the request, and the button looked identical to a Xero
      // failure while nothing had actually gone out to the network.
      const result = await sendInvoiceToXero({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        router.refresh()
        return
      }
      for (const warning of result.warnings) toast.warning(warning, { duration: 12000 })
      toast.success(`Invoice ${result.xeroInvoiceNumber} sent to Xero and closed out.`)
      router.refresh()
    })

  const onVoid = () =>
    run('void', async () => {
      if (!window.confirm('Discard this draft? The accepted quote stays in the queue and can be rebuilt.')) return
      const result = await voidInvoice({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Draft discarded.')
      router.push('/invoicing/accepted')
    })

  const onRebuild = () =>
    run('rebuild', async () => {
      if (!window.confirm('Discard this draft and rebuild it from the deal\u2019s current line items?')) return
      const result = await rebuildInvoiceFromDeal({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Rebuilt from the deal.')
      router.refresh()
    })

  const onReconcile = () =>
    run('reconcile', async () => {
      const result = await reconcileStuckInvoice({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.outcome === 'adopted'
          ? `This invoice already exists in Xero as ${result.xeroInvoiceNumber ?? 'a new invoice'}; the Hub is back in sync.`
          : 'Released. You can retry Send to Xero.',
      )
      router.refresh()
    })

  /** Open PDF bytes in a new tab. The retired quote flow proved this works
   *  under the app's CSP: a blob URL opened with window.open needs no
   *  frame-src, where an inline preview would. */
  const openPdf = (base64: string, filename: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    const tab = window.open(url, '_blank')
    if (!tab) {
      // Popup blocked. Fall back to a download so the rep still gets the
      // document rather than silently nothing.
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    }
    // Revoked late: revoking immediately races the new tab's own load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const onPreview = () =>
    run('preview', async () => {
      const result = await previewInvoicePdf({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      if (result.remittanceIncomplete) {
        toast.warning('The bank details are not configured, so the payment instructions show placeholders.', {
          duration: 10000,
        })
      }
      openPdf(result.pdfBase64, result.filename)
    })

  const onSendToTaxJar = () =>
    run('taxjar', async () => {
      const result = await sendOrderToTaxJar({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        router.refresh()
        return
      }
      for (const warning of result.warnings) toast.warning(warning, { duration: 12000 })
      toast.success(`Filed with TaxJar as ${result.transactionIds.join(', ')}. Invoice number ${result.invoiceNumber}.`)
      router.refresh()
    })

  const onGeneratePdf = () =>
    run('pdf', async () => {
      const result = await generateInvoicePdf({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      for (const warning of result.warnings) toast.warning(warning, { duration: 12000 })
      toast.success('Invoice document generated.')
      openPdf(result.pdfBase64, result.filename)
      router.refresh()
    })

  const onEmail = () =>
    run('email', async () => {
      const result = await emailInvoiceToCustomer({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error, { duration: 12000 })
        return
      }
      toast.success(
        result.wasTest
          ? `TEST SEND. The invoice went to ${result.sentTo}, not to the customer.`
          : `Invoice emailed to ${result.sentTo}.`,
        { duration: 12000 },
      )
      router.refresh()
    })

  const spinner = (name: string) => pendingAction === name && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{dealName}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : `Draft ${invoice.holding_reference}`}
            {quoteReference ? ` · Quote ${quoteReference}` : ''}
            {invoice.company_name ? ` · ${invoice.company_name}` : ''}
          </p>
        </div>
        <InvoiceStatusChip chip={status} />
      </div>

      {!invoice.taxjar_customer_id && !header.taxjar_customer_id && (
        <Card className="border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-800">
            <p className="font-semibold">No Xero account code</p>
            <p>
              Sending to Xero is blocked and TaxJar reseller exemptions will not apply until this company has its
              Xero account number filled in below.
            </p>
          </div>
        </Card>
      )}

      {linesChanged && (
        <Card className="border-amber-300 bg-amber-50 p-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <p>The deal&apos;s line items changed after this draft was built.</p>
          </div>
          {editable && (
            <Button size="sm" variant="outline" onClick={onRebuild} disabled={pendingAction !== null}>
              {spinner('rebuild')}
              Rebuild from deal
            </Button>
          )}
        </Card>
      )}

      {invoice.error_message && status !== 'completed' && (
        <Card className="border-red-200 bg-red-50 p-4 text-sm text-red-800">{invoice.error_message}</Card>
      )}

      {/* Header: the Xero invoice fields + TaxJar identity */}
      <Card className="bg-white border-gray-200 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-900 mb-1">Invoice details</h2>
        <p className="text-xs text-gray-500 mb-4">
          The invoice date is blank on purpose: it is the date the invoice is sent, so Send to Xero stamps it.
          The due date follows from it using the customer&apos;s Xero payment terms, or 30 days if Xero holds
          none. Set either by hand here to override.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="invoice_date">Invoice date</Label>
            <Input
              id="invoice_date"
              type="date"
              value={header.invoice_date}
              onChange={(e) => setHeader({ ...header, invoice_date: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div>
            <Label htmlFor="due_date">Due date</Label>
            <Input
              id="due_date"
              type="date"
              value={header.due_date}
              onChange={(e) => setHeader({ ...header, due_date: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div>
            <Label htmlFor="po_number">Customer PO number</Label>
            <Input
              id="po_number"
              value={header.customer_po_number}
              onChange={(e) => setHeader({ ...header, customer_po_number: e.target.value })}
              placeholder="Shown on the invoice as Reference"
              disabled={!editable}
            />
          </div>
          <div>
            <Label htmlFor="xero_account">Xero account number</Label>
            <Input
              id="xero_account"
              value={header.taxjar_customer_id}
              onChange={(e) => setHeader({ ...header, taxjar_customer_id: e.target.value })}
              placeholder="Doubles as the TaxJar customer id"
              disabled={!editable}
            />
          </div>
        </div>
      </Card>

      <XeroContactCard
        accountNumber={header.taxjar_customer_id}
        companyName={invoice.company_name}
        editable={editable}
      />

      {/* TaxJar ship-to */}
      <Card className="bg-white border-gray-200 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-900 mb-1">Delivery address</h2>
        <p className="text-xs text-gray-500 mb-3">
          {header.is_collection
            ? 'Not used for tax on a collected order: the sale is taxed where the goods are picked up.'
            : 'Used to calculate US sales tax: the ship-to address, not the billing address.'}
        </p>

        <label className="mb-3 flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={header.is_collection}
            onChange={(e) => setHeader({ ...header, is_collection: e.target.checked })}
            disabled={!editable}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span>
            Collected by the customer (Will Call)
            <span className="block text-xs text-gray-500">
              Sales tax is charged at the collection depot, not at the address below.
            </span>
          </span>
        </label>

        {header.is_collection && collectionDestinations.length > 0 && (
          <p className="mb-3 text-xs text-gray-600">
            Tax destination:{' '}
            {collectionDestinations.map((d) => `${d.city}, ${d.state} ${d.zip}`).join(' and ')}
          </p>
        )}
        {header.is_collection && unconfiguredCollectionDepots.length > 0 && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {unconfiguredCollectionDepots.join(' and ')} has no configured depot address, so tax cannot be
            calculated for lines collected from it.
          </p>
        )}
        {header.is_collection !== invoice.is_collection && status === 'tax_calculated' && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Changing this clears the calculated tax. Recalculate before sending.
          </p>
        )}

        {/* The address book. Hidden entirely when the customer has none yet, so
            an invoice for a first-time customer looks exactly as it did before
            this existed. Shown on a collected order as well: collection changes
            where the sale is TAXED, not whether the order has a delivery
            address, and the address still prints on the document. */}
        {addressBook.length > 0 && (
          <div className="mb-4">
            <Label htmlFor="savedAddress">Previous delivery addresses</Label>
            <select
              id="savedAddress"
              className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              value=""
              onChange={(e) => applySavedAddress(e.target.value)}
              disabled={!editable}
            >
              <option value="">Choose a saved address, or type a new one below</option>
              {addressBook.map((a) => (
                <option key={a.id} value={a.id}>
                  {deliveryAddressLabel(a)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* One row, in the order an address is written: street, city, state,
            zip, country. State and Zip were previously nested in their own
            two-column grid, which is why adding Country wrapped it underneath
            State in a quarter-width column instead of continuing the row. */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          <div className="col-span-2">
            <Label htmlFor="street">Street</Label>
            <Input
              id="street"
              value={header.delivery_street}
              onChange={(e) => setHeader({ ...header, delivery_street: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div className="col-span-2 lg:col-span-1">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={header.delivery_city}
              onChange={(e) => setHeader({ ...header, delivery_city: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div>
            <Label htmlFor="state">State</Label>
            <select
              id="state"
              className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              value={header.delivery_state}
              onChange={(e) => setHeader({ ...header, delivery_state: e.target.value })}
              disabled={!editable}
            >
              <option value="">—</option>
              {US_STATES.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.code} — {state.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="zip">Zip</Label>
            <Input
              id="zip"
              value={header.delivery_zip}
              onChange={(e) => setHeader({ ...header, delivery_zip: e.target.value })}
              onBlur={(e) => resolveZip(e.target.value)}
              placeholder="20794"
              disabled={!editable}
            />
          </div>
          <div className="col-span-2 lg:col-span-1">
            {/* One option today, and shown anyway. The column carries a CHECK
                constraint accepting only 'US', so an invoice delivering
                anywhere else is refused by the database rather than by a
                message. Putting it on the form makes that a visible rule
                instead of a surprise. Stored as 'US', shown as 'USA'. */}
            <Label htmlFor="country">Country</Label>
            <select
              id="country"
              className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              value="US"
              onChange={() => undefined}
              disabled={!editable}
            >
              {DELIVERY_COUNTRIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {zipLookup.status === 'loading' && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            Looking up the zip...
          </p>
        )}
        {zipLookup.status === 'ok' && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-gray-600">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
            <span>
              {header.delivery_zip.trim()} is <span className="font-medium text-gray-900">{zipLookup.place}</span>
              {header.delivery_state && header.delivery_state !== zipLookup.state && (
                <span className="font-semibold text-red-600">
                  {' '}but the state is set to {header.delivery_state}. Tax would be calculated for the wrong place.
                </span>
              )}
            </span>
          </p>
        )}
        {zipLookup.status === 'error' && <p className="mt-3 text-xs text-amber-700">{zipLookup.message}</p>}

        {/* The two optional lines. Both sit BELOW the tax fields on purpose:
            neither is a tax input, and neither appears in linesHash, so editing
            either can never invalidate a calculated tax. A rep can name the
            requester on an invoice that is already priced. */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="deliveryLocation">Location (optional)</Label>
            <Input
              id="deliveryLocation"
              value={header.delivery_location}
              onChange={(e) => setHeader({ ...header, delivery_location: e.target.value })}
              placeholder="Location G52"
              disabled={!editable}
            />
            <p className="mt-1 text-xs text-gray-500">
              The customer&apos;s own name for this yard or depot. Printed under the street.
            </p>
          </div>
          <div>
            <Label htmlFor="deliveryRequestedBy">Requested by (optional)</Label>
            <Input
              id="deliveryRequestedBy"
              value={header.delivery_requested_by}
              onChange={(e) => setHeader({ ...header, delivery_requested_by: e.target.value })}
              placeholder="Dan Buckley"
              disabled={!editable}
            />
            <p className="mt-1 text-xs text-gray-500">
              Printed at the foot of the delivery address.
            </p>
          </div>
        </div>

        {/* Offered on a collected order too. Ticking collection moves the TAX
            destination to the depot; it does not mean the order has no delivery
            address, and the one typed here still prints on the invoice. Hiding
            the button behind that tick made the address book unreachable on
            exactly the orders Dean was entering addresses for. */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={rememberAddress}
            disabled={!editable || pendingAction !== null}
          >
            {pendingAction === 'save-address' ? 'Saving...' : 'Save this address'}
          </Button>
          {addressNotice && <span className="text-xs text-gray-600">{addressNotice}</span>}
        </div>
      </Card>

      {/* Lines */}
      {trackingLoad === 'failed' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            Xero tracking categories could not be loaded.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            {trackingError} Nothing else is affected, but no tracking will be sent to Xero for this
            invoice until this loads. Reload the page to try again.
          </p>
        </div>
      )}
      {trackingLoad === 'empty' && (
        <p className="text-xs text-gray-500">
          Xero has no active tracking categories, so there is nothing to pick on these lines.
        </p>
      )}

      {/* Xero's item codes, for the per-line pickers. Empty until the list has
          been fetched (first focus on an item-code field), which is harmless:
          a datalist with no options just leaves the input as free text, which
          is how the field behaved before and how it must keep behaving when
          Xero cannot be reached. The account code is shown against each entry
          so it is clear what picking one will fill in. */}
      <datalist id={ITEM_CODE_LIST_ID}>
        {Object.entries(itemAccounts ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, account]) => (
            <option key={code} value={code}>
              {account ?? 'no sales account'}
            </option>
          ))}
      </datalist>

      <Card className="bg-white border-gray-200 p-0 overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-700">
              <th className="px-3 py-3">Item</th>
              <th className="px-3 py-3">Description</th>
              <th className="px-3 py-3 w-20">Qty</th>
              <th className="px-3 py-3 w-28">Unit price</th>
              <th className="px-3 py-3 w-20">Disc %</th>
              <th className="px-3 py-3 w-24">Account</th>
              <th className="px-3 py-3 w-32">Ships from</th>
              {/* Only rendered when Xero actually has tracking configured, so
                  an organisation that uses none does not get a dead column. */}
              {trackingCategories.length > 0 && <th className="px-3 py-3 w-44">Tracking</th>}
              <th className="px-3 py-3 w-28 text-right">Line total</th>
              <th className="px-3 py-3 w-28 text-right">Tax</th>
              <th className="px-3 py-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const lineTotal = computeDraftLineTotal(
                Number(row.quantity) || 0,
                Number(row.unit_price) || 0,
                Number(row.discount_percentage) || 0,
              )
              return (
                <tr key={row.line_key} className="border-b border-gray-100 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <Input
                      value={row.name}
                      onChange={(e) => updateRow(row.line_key, { name: e.target.value })}
                      disabled={!editable}
                      className="min-w-36"
                    />
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">{row.sku || 'no SKU'}</span>
                      <span className="text-xs text-gray-400" aria-hidden="true">&rarr;</span>
                      <Input
                        value={row.xero_item_code}
                        onChange={(e) => updateRow(row.line_key, { xero_item_code: e.target.value })}
                        // Pull Xero's item list on focus, so typing "LTL"
                        // narrows to the LTL codes. Still not on page load: an
                        // invoice nobody recodes pays no Xero round trip.
                        onFocus={() => {
                          if (codingEditable) void loadItemAccounts()
                        }}
                        // On blur, not on change: the account follows a
                        // FINISHED item code, never the letters on the way in.
                        onBlur={(e) => {
                          if (codingEditable) void syncAccountFromItemCode(row.line_key, e.target.value)
                        }}
                        list={codingEditable ? ITEM_CODE_LIST_ID : undefined}
                        placeholder="Xero item code"
                        disabled={!codingEditable}
                        aria-label="Xero item code"
                        title="Pick from Xero's item list or type a code. The account code fills in when you leave the field."
                        className="h-7 min-w-28 py-0 text-xs"
                      />
                      {/* Freight has to be flagged, not inferred: is_shipping
                          comes from the SKU (LTLNA), and a manual line has no
                          SKU, so without this a hand-added freight line goes to
                          TaxJar as taxable goods. Only manual lines are
                          toggleable; the server pins the rest. */}
                      {row.origin === 'manual' && editable ? (
                        <label
                          className="flex cursor-pointer items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-sky-100 hover:text-sky-800 has-[:checked]:bg-sky-100 has-[:checked]:text-sky-800"
                          title="Bill this line as freight. TaxJar taxes shipping by the destination's own freight rules, not the goods rules."
                        >
                          <input
                            type="checkbox"
                            className="h-3 w-3 cursor-pointer accent-sky-600"
                            checked={row.is_shipping}
                            onChange={(e) => updateRow(row.line_key, { is_shipping: e.target.checked })}
                          />
                          Shipping
                        </label>
                      ) : (
                        row.is_shipping && (
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
                            Shipping
                          </span>
                        )
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={row.description}
                      onChange={(e) => updateRow(row.line_key, { description: e.target.value })}
                      disabled={!editable}
                      className="min-w-48"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(e) => updateRow(row.line_key, { quantity: e.target.value })}
                      disabled={!editable}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      value={row.unit_price}
                      onChange={(e) => updateRow(row.line_key, { unit_price: e.target.value })}
                      disabled={!editable}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      value={row.discount_percentage}
                      onChange={(e) => updateRow(row.line_key, { discount_percentage: e.target.value })}
                      disabled={!editable}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={row.account_code}
                      onChange={(e) => updateRow(row.line_key, { account_code: e.target.value })}
                      placeholder="required"
                      disabled={!codingEditable}
                      aria-label="Xero account code"
                      aria-invalid={!row.account_code.trim()}
                      title={
                        row.account_code.trim()
                          ? undefined
                          : 'No Xero account: this revenue would post to the default sales account. Set the item code, or type the account.'
                      }
                      className={row.account_code.trim() ? undefined : 'border-amber-400 placeholder-amber-600'}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {row.ship_from_locked ? (
                      <span
                        className="inline-flex h-9 items-center gap-1.5 text-gray-600"
                        title="Fitting-kit components ship from Baltimore"
                      >
                        <Lock className="h-3.5 w-3.5 text-gray-400" />
                        {depotLabel('US-BAL')}
                      </span>
                    ) : (
                      <select
                        className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                        value={row.ship_from_depot}
                        onChange={(e) =>
                          updateRow(row.line_key, {
                            ship_from_depot: e.target.value as 'US-BAL' | 'US-SBD',
                            // Clearing it makes the save path re-resolve the
                            // item code for the NEW depot. Keeping it would
                            // bill a Baltimore item on a California shipment.
                            xero_item_code: '',
                          })
                        }
                        disabled={!editable}
                      >
                        {US_DEPOTS.map((depot) => (
                          <option key={depot} value={depot}>
                            {depotLabel(depot)}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  {trackingCategories.length > 0 && (
                    <td className="px-3 py-2">
                      {/* One picker per ACTIVE category. Xero allows at most two
                          categories per organisation and at most two tracking
                          elements per line, so the two limits coincide and
                          there is nothing to cap here beyond what Xero offers. */}
                      <div className="space-y-1.5">
                        {trackingCategories.map((category) => {
                          const chosen = row.tracking.find((t) => t.categoryId === category.categoryId)
                          return (
                            <select
                              key={category.categoryId}
                              aria-label={category.name}
                              title={category.name}
                              className="flex h-8 w-full rounded-md border border-gray-300 bg-white px-2 py-0 text-xs shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                              value={chosen?.optionId ?? ''}
                              onChange={(e) =>
                                updateRow(row.line_key, {
                                  tracking: setLineTracking(row.tracking, category, e.target.value),
                                })
                              }
                              disabled={!editable}
                            >
                              <option value="">{category.name}: none</option>
                              {category.options.map((option) => (
                                <option key={option.optionId} value={option.optionId}>
                                  {category.name}: {option.name}
                                </option>
                              ))}
                            </select>
                          )
                        })}
                      </div>
                    </td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums pt-4">{money.format(lineTotal)}</td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      value={row.tax_amount}
                      placeholder="—"
                      onChange={(e) =>
                        updateRow(row.line_key, {
                          tax_amount: e.target.value,
                          // Only a value that actually differs from the stored
                          // TaxJar figure counts as an override, so retyping
                          // the same number (or undoing an edit) clears the
                          // flag instead of latching it on forever.
                          tax_override: e.target.value !== (calculatedTaxByKey.get(row.line_key) ?? ''),
                        })
                      }
                      disabled={!editable || status !== 'tax_calculated'}
                      className="text-right"
                    />
                    {row.tax_override && (
                      <p className="mt-1 text-right text-[10px] font-medium text-amber-700">manual override</p>
                    )}
                  </td>
                  <td className="px-3 py-2 pt-3">
                    {editable && (
                      <button
                        type="button"
                        onClick={() => removeLine(row.line_key)}
                        aria-label={`Remove ${row.name || 'line'}`}
                        className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {editable && (
          <div className="border-t border-gray-100 p-3">
            <Button size="sm" variant="outline" onClick={addLine}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add line
            </Button>
          </div>
        )}
      </Card>

      {taxGroups.length > 0 && (
        <Card className="bg-white border-gray-200 p-4 sm:p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-900 mb-1">Tax calculation</h2>
          <p className="text-xs text-gray-500 mb-4">
            Where TaxJar decided each shipment was taxed. Check the place, not just the rate: a wrong zip
            returns a different number rather than an error.
          </p>
          <div className="space-y-3">
            {taxGroups.map((g) => (
              <div key={g.depot} className="rounded-md border border-gray-200 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900">
                    {header.is_collection ? 'Collected from' : 'Ships from'} {g.depot}
                  </span>
                  <span className="tabular-nums text-gray-600">
                    {g.rate === null ? 'no rate' : `${(g.rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`}
                    {g.collected !== null && ` · ${money.format(g.collected)}`}
                  </span>
                </div>
                {g.from && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {g.from.street}, {g.from.city}, {g.from.state} {g.from.zip}
                  </p>
                )}
                <p className="mt-1.5 text-gray-700">
                  Taxed in <span className="font-medium text-gray-900">{g.place}</span>
                </p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  <span>Freight {g.freightTaxable ? 'taxable' : 'not taxable'}</span>
                  {g.source && <span>Sourcing: {g.source}</span>}
                  {!g.hasNexus && <span className="font-semibold text-amber-700">No nexus, zero tax</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Totals + actions */}
      <Card className="bg-white border-gray-200 p-4 sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1 text-sm text-gray-700 sm:min-w-64">
            <div className="flex justify-between gap-8">
              <span>Subtotal</span>
              <span className="tabular-nums">{money.format(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between gap-8">
              <span>Shipping</span>
              <span className="tabular-nums">{money.format(totals.shipping)}</span>
            </div>
            <div className="flex justify-between gap-8">
              <span>Sales tax</span>
              <span className="tabular-nums">{totals.tax === null ? 'not calculated' : money.format(totals.tax)}</span>
            </div>
            <div className="flex justify-between gap-8 border-t border-gray-200 pt-1 font-semibold text-gray-900">
              <span>Total</span>
              <span className="tabular-nums">
                {totals.tax === null ? '—' : money.format(roundCents(totals.subtotal + totals.shipping + totals.tax))}
              </span>
            </div>

            <TaxDetail taxjarResponse={invoice.taxjar_response} currency={invoice.currency} />
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            {editable && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={onSave} disabled={pendingAction !== null}>
                  {spinner('save')}
                  Save draft
                </Button>
              </div>
            )}
            {/* The pipeline, in order. Exactly one step is the next one, so
                only that button is offered: a rep should never have to work out
                which of five actions comes now. Xero is LAST because the
                customer-facing document is the Hub's PDF and Xero is the book
                of record (Dean, 2026-09-03). */}
            {canManage && status === 'tax_calculated' && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" onClick={onPreview} disabled={pendingAction !== null}>
                  {spinner('preview')}
                  Preview invoice
                </Button>
                <Button onClick={onSendToTaxJar} disabled={pendingAction !== null} className="bg-green-700 hover:bg-green-800">
                  {spinner('taxjar')}
                  Send to TaxJar
                </Button>
              </div>
            )}
            {canManage && status === 'tax_calculated' && (
              <p className="text-xs text-gray-500 sm:text-right">
                Sending to TaxJar files the sale and allocates the invoice number. Preview first: it changes nothing.
              </p>
            )}

            {/* The invoice is frozen from here on, but its Xero coding is not.
                Those two columns never reach the customer's document, so they
                stay fixable right up until Xero has actually used them. */}
            {codingNeedsOwnSave && codingDirty && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <p className="mr-auto text-xs text-amber-700">
                  Xero item or account codes have been changed and not saved.
                </p>
                <Button variant="outline" onClick={onSaveCoding} disabled={pendingAction !== null}>
                  {spinner('coding')}
                  Save Xero codes
                </Button>
              </div>
            )}

            {canManage && status === 'filed' && (
              <Button onClick={onGeneratePdf} disabled={pendingAction !== null} className="bg-green-700 hover:bg-green-800">
                {spinner('pdf')}
                Generate invoice PDF
              </Button>
            )}

            {canManage && status === 'documented' && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" onClick={onPreview} disabled={pendingAction !== null}>
                  {spinner('preview')}
                  View PDF
                </Button>
                {/* Regenerate has to be reachable HERE, not only from the
                    previous step. Emailing re-renders and refuses if the bytes
                    no longer match the hash taken at Generate, which is exactly
                    what should happen when the document has changed. Without
                    this button that refusal was a dead end. */}
                <Button variant="outline" onClick={onGeneratePdf} disabled={pendingAction !== null}>
                  {spinner('pdf')}
                  Regenerate PDF
                </Button>
                <Button onClick={onEmail} disabled={pendingAction !== null} className="bg-green-700 hover:bg-green-800">
                  {spinner('email')}
                  Email to customer
                </Button>
              </div>
            )}

            {canManage && status === 'sent' && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" onClick={onPreview} disabled={pendingAction !== null}>
                  {spinner('preview')}
                  View PDF
                </Button>
                <Button onClick={onSend} disabled={pendingAction !== null} className="bg-green-700 hover:bg-green-800">
                  {spinner('send')}
                  Send to Xero and attach PDF
                </Button>
              </div>
            )}

            {canManage && status === 'completed' && (
              <Button variant="outline" onClick={onPreview} disabled={pendingAction !== null}>
                {spinner('preview')}
                View PDF
              </Button>
            )}

            {editable && (
              <Button variant="ghost" onClick={onVoid} disabled={pendingAction !== null} className="text-red-600 hover:bg-red-50">
                {spinner('void')}
                Discard draft
              </Button>
            )}
            {terminal && status !== 'authorizing' && (
              <p className="text-xs text-gray-500 sm:text-right">
                This invoice lives in Xero now{invoice.xero_invoice_number ? ` as ${invoice.xero_invoice_number}` : ''}.
                Corrections happen there (credit note), not in the Hub.
              </p>
            )}
            {status === 'authorizing' && (
              <div className="flex flex-col items-stretch gap-2 sm:items-end">
                <p className="text-xs text-purple-700 sm:text-right">
                  Being sent to Xero. If this has not settled within 10 minutes, reconcile it: that adopts the
                  Xero invoice if one was created, and otherwise releases this draft so you can retry.
                </p>
                {canManage && (
                  <Button variant="outline" size="sm" onClick={onReconcile} disabled={pendingAction !== null}>
                    {spinner('reconcile')}
                    Reconcile with Xero
                  </Button>
                )}
              </div>
            )}
            {status === 'tax_calculated' && invoice.xero_invoice_id && canManage && (
              <div className="flex flex-col items-stretch gap-2 sm:items-end">
                <p className="text-xs text-amber-700 sm:text-right">
                  This invoice already exists in Xero as{' '}
                  {invoice.xero_invoice_number ?? invoice.xero_invoice_id}, but the Hub did not record it.
                  Reconcile instead of sending it again.
                </p>
                <Button variant="outline" size="sm" onClick={onReconcile} disabled={pendingAction !== null}>
                  {spinner('reconcile')}
                  Reconcile with Xero
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
