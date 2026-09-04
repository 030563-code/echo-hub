'use server'

/**
 * Save the draft invoice: header fields + full line replace, atomically via
 * the save_customer_invoice RPC. Tax results are preserved server-side when
 * nothing tax-relevant changed; otherwise the invoice drops back to draft and
 * tax is cleared. A reviewer's manual tax edit is passed as an explicit
 * override and flagged, never silently absorbed.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeDraftLineTotal } from '@/lib/customer-invoice/build-draft'
import { US_DEPOTS, KIT_SHIP_FROM } from '@/lib/customer-invoice/constants'
import { MAX_TRACKING_PER_LINE } from '@/lib/customer-invoice/tracking'
import { linesHash } from '@/lib/customer-invoice/hash'
import { US_STATE_CODES } from '@/lib/us-address'
import { roundCents } from '@/lib/quote-math'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  lookupXeroItemCodes,
} from '@/app/actions/invoicing/shared'

const LineInput = z.object({
  line_key: z.string().min(1).max(64),
  sort_order: z.number().int().min(0),
  origin: z.enum(['hubspot', 'kit_split', 'manual']),
  parent_line_key: z.string().max(64).nullable(),
  hs_line_item_id: z.string().max(64).nullable(),
  hs_product_id: z.string().max(64).nullable(),
  sku: z.string().max(64).nullable(),
  account_code: z.string().max(32).nullable(),
  /** Editable: a typed code overrides the SKU-and-depot mapping. */
  xero_item_code: z.string().max(64).nullable(),
  name: z.string().min(1).max(255),
  description: z.string().max(4000).nullable(),
  quantity: z.number().finite().min(0),
  unit_price: z.number().finite().min(0),
  discount_percentage: z.number().finite().min(0).max(100),
  is_shipping: z.boolean(),
  ship_from_depot: z.enum(US_DEPOTS),
  // Xero's own limit: "Any LineItem can have a maximum of 2 <TrackingCategory>
  // elements." Refused here as well as by a CHECK constraint, so a bad payload
  // never reaches the database or n8n.
  tracking: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        categoryName: z.string(),
        optionId: z.string().min(1),
        optionName: z.string(),
      }),
    )
    .max(MAX_TRACKING_PER_LINE)
    .optional(),
  /** Present only when the reviewer manually edited the tax amount. */
  tax_amount_override: z.number().finite().min(0).nullable().optional(),
})

const Input = z.object({
  invoiceId: z.string().uuid(),
  header: z.object({
    invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    customer_po_number: z.string().max(120).nullable(),
    taxjar_customer_id: z.string().max(64).nullable(),
    delivery_street: z.string().max(255).nullable(),
    delivery_city: z.string().max(100).nullable(),
    delivery_state: z.enum(US_STATE_CODES).nullable(),
    delivery_zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'Delivery zip must be 5 digits or ZIP+4.').nullable(),
    // Both optional and free text. A site label is whatever the customer calls
    // that yard ("Location G52") and a requester is a person's name, so neither
    // can be validated beyond a length. Neither is a tax input, which is why
    // neither appears in linesHash: editing one must not throw away a valid
    // TaxJar calculation.
    delivery_location: z.string().trim().max(120).nullable(),
    delivery_requested_by: z.string().trim().max(120).nullable(),
    // Required, never defaulted: a stale browser tab that posts without the key
    // must be REJECTED, not silently treated as a delivered order. Defaulting
    // it to false would change the jurisdiction the tax is calculated in
    // without anyone touching the checkbox.
    is_collection: z.boolean(),
  }),
  lines: z.array(LineInput).min(1).max(200),
})

export type SaveDraftResult =
  | { success: true; status: string; taxInvalidated: boolean }
  | { success: false; error: string }

export async function saveInvoiceDraft(input: z.infer<typeof Input>): Promise<SaveDraftResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid invoice data' }
  }
  const { invoiceId, header, lines } = parsed.data

  const keys = new Set(lines.map((l) => l.line_key))
  if (keys.size !== lines.length) return { success: false, error: 'Line keys must be unique.' }

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines: storedLines } = loaded

  if (invoice.status !== 'draft' && invoice.status !== 'tax_calculated') {
    return { success: false, error: `This invoice is ${invoice.status} and can no longer be edited.` }
  }

  // Kit components stay pinned to Baltimore. The pin is decided from the
  // STORED line (matched by line_key), never from the client-supplied origin:
  // a crafted payload could otherwise relabel a kit component as 'manual' and
  // have its tax calculated from the wrong dispatch state.
  const storedByKey = new Map(storedLines.map((l) => [l.line_key, l]))
  const normalized = lines.map((l) => {
    const stored = storedByKey.get(l.line_key)
    const isKitComponent = stored ? stored.origin === 'kit_split' : l.origin === 'kit_split'
    return {
    ...l,
    origin: stored ? stored.origin : l.origin,
    ship_from_depot: isKitComponent ? KIT_SHIP_FROM : l.ship_from_depot,
    ship_from_locked: isKitComponent,
    quantity: roundCents(l.quantity),
    unit_price: roundCents(l.unit_price),
    discount_percentage: roundCents(l.discount_percentage),
    }
  })

  // Xero item codes are always re-resolved server-side for the line's own
  // ship-from depot; the client never supplies them.
  const codes = await lookupXeroItemCodes(normalized.map((l) => ({ sku: l.sku, depot: l.ship_from_depot })))

  const rpcLines = normalized.map((l) => ({
    line_key: l.line_key,
    sort_order: l.sort_order,
    origin: l.origin,
    parent_line_key: l.parent_line_key,
    hs_line_item_id: l.hs_line_item_id,
    hs_product_id: l.hs_product_id,
    sku: l.sku,
    // A code typed in the editor wins. Blank falls back to the SKU-and-depot
    // mapping, which is what makes changing the ship-from depot re-resolve the
    // code (the editor clears it on that change) instead of shipping H9BALT on
    // a line that now dispatches from San Bernardino.
    xero_item_code: l.xero_item_code?.trim() || (l.sku ? (codes.get(`${l.sku}|${l.ship_from_depot}`) ?? null) : null),
    account_code: l.account_code,
    name: l.name,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    discount_percentage: l.discount_percentage,
    line_total: computeDraftLineTotal(l.quantity, l.unit_price, l.discount_percentage),
    is_shipping: l.is_shipping,
    ship_from_depot: l.ship_from_depot,
    tracking: l.tracking ?? [],
    ship_from_locked: l.ship_from_locked,
  }))

  const newHash = linesHash(rpcLines, {
    delivery_street: header.delivery_street,
    delivery_city: header.delivery_city,
    delivery_state: header.delivery_state,
    delivery_zip: header.delivery_zip,
    // delivery_location and delivery_requested_by are deliberately absent. This
    // hash exists to detect a STALE TAX CALCULATION, and a yard's site label or
    // the name of whoever ordered changes nothing about where the sale is
    // taxed. Including them would throw away a valid TaxJar result every time
    // someone typed a name.
    taxjar_customer_id: header.taxjar_customer_id,
    is_collection: header.is_collection,
  })
  const preserveTax = invoice.status === 'tax_calculated' && newHash === invoice.lines_hash

  // Explicit manual tax overrides: only lines whose override value differs
  // from what is stored, and only while the calculation is still valid.
  const storedTaxByKey = new Map(storedLines.map((l) => [l.line_key, l.tax_amount]))
  const overrides = preserveTax
    ? normalized
        .filter(
          (l) =>
            l.tax_amount_override !== null &&
            l.tax_amount_override !== undefined &&
            roundCents(l.tax_amount_override) !== (storedTaxByKey.get(l.line_key) ?? null),
        )
        .map((l) => ({ line_key: l.line_key, tax_amount: roundCents(l.tax_amount_override as number) }))
    : []

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_customer_invoice', {
    p_invoice_id: invoiceId,
    p_header: header,
    p_lines: rpcLines,
    p_actor: gate.auth.user.id,
    p_preserve_tax: preserveTax,
    p_new_hash: newHash,
    p_overrides: overrides,
  })

  if (error) {
    if (/INVALID_STATUS/.test(error.message ?? '')) {
      return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
    }
    // The reviewer gets a generic message, deliberately: a Postgres error names
    // columns and constraints and does not belong on screen. But it has to go
    // SOMEWHERE. A column-alignment bug inside save_customer_invoice failed
    // every save for a day (2026-09-03 12:24 UTC to 2026-09-04), and with
    // nothing logged it read as a problem with whichever line or address the
    // reviewer happened to be editing.
    console.error('save_customer_invoice failed:', error.code, error.message)
    return { success: false, error: 'Could not save the invoice.' }
  }

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  const result = data as { status: string; tax_invalidated: boolean }
  return { success: true, status: result.status, taxInvalidated: result.tax_invalidated }
}
