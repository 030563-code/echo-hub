'use client'

/**
 * Draft-invoice editor: the union of Xero's invoice fields and TaxJar's
 * inputs, every field present and editable even when empty. Per-line ship-from
 * depot drives the grouped TaxJar calculation; fitting-kit components stay
 * pinned to Baltimore. Buttons follow the product rule: every submit shows a
 * pending state and is disabled while in flight.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, Lock, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { US_STATE_CODES } from '@/lib/us-address'
import {
  US_DEPOTS,
  DEPOT_FROM_ADDRESSES,
  type CustomerInvoiceStatus,
  type USDepot,
} from '@/lib/customer-invoice/constants'
import { computeDraftLineTotal } from '@/lib/customer-invoice/build-draft'
import { roundCents } from '@/lib/quote-math'
import type { CustomerInvoiceLineRow, CustomerInvoiceRow } from '@/app/actions/invoicing/shared'
import { saveInvoiceDraft } from '@/app/actions/invoicing/save-draft'
import { calculateInvoiceTax } from '@/app/actions/invoicing/calculate-tax'
import { sendInvoiceToXero } from '@/app/actions/invoicing/send-to-xero'
import { voidInvoice } from '@/app/actions/invoicing/void-invoice'
import { rebuildInvoiceFromDeal } from '@/app/actions/invoicing/rebuild-invoice'
import { retryTaxJarRecord } from '@/app/actions/invoicing/record-taxjar'
import { reconcileStuckInvoice } from '@/app/actions/invoicing/reset-authorizing'
import { InvoiceStatusChip } from '../status-chip'

interface EditableLine {
  line_key: string
  origin: 'hubspot' | 'kit_split' | 'manual'
  parent_line_key: string | null
  hs_line_item_id: string | null
  hs_product_id: string | null
  sku: string
  xero_item_code: string | null
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
}

interface InvoiceEditorProps {
  invoice: CustomerInvoiceRow
  lines: CustomerInvoiceLineRow[]
  dealName: string
  quoteReference: string | null
  linesChanged: boolean
  canManage: boolean
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
    xero_item_code: line.xero_item_code,
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
  }
}

export function InvoiceEditor({ invoice, lines, dealName, quoteReference, linesChanged, canManage }: InvoiceEditorProps) {
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
    is_collection: invoice.is_collection,
  })
  const [rows, setRows] = useState<EditableLine[]>(lines.map(toEditable))
  // What TaxJar last returned per line, used to decide whether an edited tax
  // cell is genuinely a manual override.
  const calculatedTaxByKey = useMemo(
    () => new Map(lines.map((l) => [l.line_key, l.tax_amount === null ? '' : String(l.tax_amount)])),
    [lines],
  )
  // Deliberately opt-IN: emailing is the outward-facing, irreversible half of
  // Send, and the editor remounts on every server write, so a default of true
  // could silently undo a reviewer's decision not to email.
  const [emailToCustomer, setEmailToCustomer] = useState(false)

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
  const terminal = status === 'authorized' || status === 'sent' || status === 'completed' || status === 'authorizing'

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
        xero_item_code: null,
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
      name: row.name || 'Line item',
      description: row.description || null,
      quantity: Number(row.quantity) || 0,
      unit_price: Number(row.unit_price) || 0,
      discount_percentage: Number(row.discount_percentage) || 0,
      is_shipping: row.is_shipping,
      ship_from_depot: row.ship_from_depot,
      tax_amount_override:
        row.tax_override && row.tax_amount !== '' && row.tax_amount !== calculatedTaxByKey.get(row.line_key)
          ? Number(row.tax_amount) || 0
          : null,
    })),
  })

  const onSave = () =>
    run('save', async () => {
      const result = await saveInvoiceDraft(buildSavePayload())
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(result.taxInvalidated ? 'Saved. Tax cleared: recalculate before sending.' : 'Saved.')
      router.refresh()
    })

  const onCalculate = () =>
    run('calculate', async () => {
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
      toast.success(`Tax calculated: ${money.format(result.taxTotal)} (total ${money.format(result.total)}).`)
      router.refresh()
    })

  const onSend = () =>
    run('send', async () => {
      // Save first: the editor holds unsaved edits in local state, and the
      // server sends Xero what is STORED. Saving here means a change that
      // affects tax invalidates the calculation instead of quietly shipping a
      // stale invoice.
      const saved = await saveInvoiceDraft(buildSavePayload())
      if (!saved.success) {
        toast.error(saved.error)
        return
      }
      if (saved.taxInvalidated) {
        toast.warning('Your edits changed the tax base. Recalculate tax before sending.')
        router.refresh()
        return
      }
      const result = await sendInvoiceToXero({ invoiceId: invoice.id, emailToCustomer })
      if (!result.success) {
        toast.error(result.error)
        router.refresh()
        return
      }
      for (const warning of result.warnings) toast.warning(warning, { duration: 12000 })
      toast.success(
        `Invoice ${result.xeroInvoiceNumber} created in Xero${result.emailed ? ' and emailed to the customer' : ''}.`,
      )
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

  const onRetryRecord = () =>
    run('record', async () => {
      const result = await retryTaxJarRecord({ invoiceId: invoice.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Recorded in TaxJar for filing.')
      router.refresh()
    })

  const spinner = (name: string) => pendingAction === name && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{dealName}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {invoice.xero_invoice_number ? `Xero invoice ${invoice.xero_invoice_number}` : `Draft ${invoice.invoice_number}`}
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
      <Card className="p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Invoice details</h2>
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

      {/* TaxJar ship-to */}
      <Card className="p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">Delivery address</h2>
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Label htmlFor="street">Street</Label>
            <Input
              id="street"
              value={header.delivery_street}
              onChange={(e) => setHeader({ ...header, delivery_street: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div>
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={header.delivery_city}
              onChange={(e) => setHeader({ ...header, delivery_city: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
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
                {US_STATE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
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
                placeholder="20794"
                disabled={!editable}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Lines */}
      <Card className="p-0 overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-3 py-3">Item</th>
              <th className="px-3 py-3">Description</th>
              <th className="px-3 py-3 w-20">Qty</th>
              <th className="px-3 py-3 w-28">Unit price</th>
              <th className="px-3 py-3 w-20">Disc %</th>
              <th className="px-3 py-3 w-24">Account</th>
              <th className="px-3 py-3 w-32">Ships from</th>
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
                    <p className="mt-1 text-xs text-gray-400">
                      {row.sku || 'no SKU'}
                      {row.xero_item_code ? ` → ${row.xero_item_code}` : ''}
                      {row.is_shipping && (
                        <span className="ml-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
                          Shipping
                        </span>
                      )}
                    </p>
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
                      placeholder="default"
                      disabled={!editable}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {row.ship_from_locked ? (
                      <span
                        className="inline-flex h-9 items-center gap-1.5 text-gray-600"
                        title="Fitting-kit components ship from Baltimore"
                      >
                        <Lock className="h-3.5 w-3.5 text-gray-400" />
                        US-BAL
                      </span>
                    ) : (
                      <select
                        className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                        value={row.ship_from_depot}
                        onChange={(e) => updateRow(row.line_key, { ship_from_depot: e.target.value as 'US-BAL' | 'US-SBD' })}
                        disabled={!editable}
                      >
                        {US_DEPOTS.map((depot) => (
                          <option key={depot} value={depot}>
                            {depot}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
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

      {/* Totals + actions */}
      <Card className="p-4 sm:p-6">
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
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            {editable && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={onSave} disabled={pendingAction !== null}>
                  {spinner('save')}
                  Save draft
                </Button>
                <Button onClick={onCalculate} disabled={pendingAction !== null}>
                  {spinner('calculate')}
                  Send to TaxJar
                </Button>
              </div>
            )}
            {editable && status === 'tax_calculated' && (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={emailToCustomer}
                    onChange={(e) => setEmailToCustomer(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Email the customer via Xero
                </label>
                <Button onClick={onSend} disabled={pendingAction !== null} className="bg-green-700 hover:bg-green-800">
                  {spinner('send')}
                  Send to Xero
                </Button>
              </div>
            )}
            {editable && (
              <Button variant="ghost" onClick={onVoid} disabled={pendingAction !== null} className="text-red-600 hover:bg-red-50">
                {spinner('void')}
                Discard draft
              </Button>
            )}
            {canManage && (status === 'authorized' || status === 'sent') && (
              <Button variant="outline" onClick={onRetryRecord} disabled={pendingAction !== null}>
                {spinner('record')}
                Record in TaxJar
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
