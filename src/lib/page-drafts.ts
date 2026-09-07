/**
 * The smaller page drafts: one schema and one key each.
 *
 * The quote builder and the deal wizard carry enough shape to earn their own
 * modules (quote-builder-draft.ts, deal-wizard-draft.ts). Everything else is a
 * handful of fields and lives here, so a new page is one small block rather
 * than a new file.
 *
 * Every schema is versioned with `v: 1`. A draft written by an older build that
 * no longer parses is treated as no draft at all, never as an error, so a
 * deploy can never break the page it belongs to.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Raise a purchase order
// ---------------------------------------------------------------------------

export const RAISE_PO_KEY = 'raise-po'

const poLineSchema = z.object({
  sku: z.string(),
  // Held as free text so the box can be cleared and retyped, exactly as the
  // form holds it. Coerced to a number only at submit.
  quantity: z.string(),
  hs_code: z.string(),
  unit_price: z.string(),
})

export const raisePoDraftSchema = z.object({
  v: z.literal(1),
  fromEntity: z.string(),
  deliveryAddress: z.string(),
  notes: z.string(),
  lines: z.array(poLineSchema).max(200),
  templateId: z.string(),
})

export type RaisePoDraft = z.infer<typeof raisePoDraftSchema>

export function parseRaisePoDraft(raw: unknown): RaisePoDraft | null {
  const parsed = raisePoDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Transport: the Add Shipment panel
// ---------------------------------------------------------------------------

export const TRANSPORT_ADD_SHIPMENT_KEY = 'transport:add-shipment'

export const shipmentDraftSchema = z.object({
  v: z.literal(1),
  // Mirrors ShipmentForm exactly, unions included. A looser shape here would
  // hand the form a depot or a status it cannot represent, and the restore
  // would be the first place to find out.
  form: z.object({
    spot_id: z.string(),
    container_ref: z.string().optional(),
    sku: z.string(),
    qty: z.string(),
    depot_destination: z.enum(['US-BAL', 'US-SBD', 'CA-HAM']),
    status: z.enum(['on_water', 'at_port', 'customs', 'delivered']),
    shipped_at: z.string().optional(),
    eta: z.string().optional(),
    po_reference: z.string().optional(),
  }),
  lookupRef: z.string(),
})

export type ShipmentDraft = z.infer<typeof shipmentDraftSchema>

export function parseShipmentDraft(raw: unknown): ShipmentDraft | null {
  const parsed = shipmentDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// BOM: typed material prices, before they are committed
// ---------------------------------------------------------------------------

export const BOM_MATERIAL_PRICES_KEY = 'bom:material-prices'

export const materialPriceDraftSchema = z.object({
  v: z.literal(1),
  /** material code to the price as typed, so a half-typed "12." survives. */
  prices: z.record(z.string(), z.string()),
})

export type MaterialPriceDraft = z.infer<typeof materialPriceDraftSchema>

export function parseMaterialPriceDraft(raw: unknown): MaterialPriceDraft | null {
  const parsed = materialPriceDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// View state: filters, search boxes, tabs, sorts.
//
// Restored silently, so the shapes stay deliberately small and dull. Anything
// that could send a user somewhere surprising (a paging cursor above all)
// belongs nowhere near these.
// ---------------------------------------------------------------------------

/** A plain search box. */
export const searchViewSchema = z.object({ v: z.literal(1), q: z.string().max(200) })
export type SearchView = z.infer<typeof searchViewSchema>
export function parseSearchView(raw: unknown): SearchView | null {
  const parsed = searchViewSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The purchase-order board: which view, the search box, and the open card. */
export const poBoardViewSchema = z.object({
  v: z.literal(1),
  view: z.enum(['kanban', 'table']),
  q: z.string().max(200),
})
export type PoBoardView = z.infer<typeof poBoardViewSchema>
export function parsePoBoardView(raw: unknown): PoBoardView | null {
  const parsed = poBoardViewSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The BOM page: which tab, and its search box. */
export const bomViewSchema = z.object({
  v: z.literal(1),
  tab: z.enum(['orders', 'materials', 'master']),
  q: z.string().max(200),
})
export type BomView = z.infer<typeof bomViewSchema>
export function parseBomView(raw: unknown): BomView | null {
  const parsed = bomViewSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * A sortable, searchable table (the shared BoardTable).
 *
 * The page INDEX is deliberately absent. A remembered page number lands someone
 * on rows that have since moved, which reads as data loss rather than as a
 * convenience; the same reasoning already keeps `page` and `cursors` out of the
 * quotes tab navigation.
 */
export const tableViewSchema = z.object({
  v: z.literal(1),
  q: z.string().max(200),
  sort: z
    .array(z.object({ id: z.string().max(120), desc: z.boolean() }))
    .max(4),
})
export type TableView = z.infer<typeof tableViewSchema>
export function parseTableView(raw: unknown): TableView | null {
  const parsed = tableViewSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// The customer invoice editor
//
// Fingerprinted against the invoice row, and DISCARDED rather than restored
// when that row has moved on: these numbers become a tax filing and a Xero
// document, so putting stale ones back is the one restore that could cost real
// money.
// ---------------------------------------------------------------------------

export function invoiceEditorKey(invoiceId: string): string {
  return `invoice-editor:${invoiceId}`
}

export const invoiceEditorDraftSchema = z.object({
  v: z.literal(1),
  header: z.object({
    invoice_date: z.string(),
    due_date: z.string(),
    customer_po_number: z.string(),
    taxjar_customer_id: z.string(),
    delivery_street: z.string(),
    delivery_city: z.string(),
    delivery_state: z.string(),
    delivery_zip: z.string(),
    delivery_location: z.string(),
    delivery_requested_by: z.string(),
    is_collection: z.boolean(),
  }),
  // Spelled out rather than left permissive. These rows become a tax filing and
  // a Xero document, so a field arriving as the wrong type has to fail the parse
  // and drop the draft, not reach the arithmetic. The money fields are strings
  // because the editor holds them as typed text, exactly like every other form
  // in the Hub.
  rows: z
    .array(
      z.object({
        line_key: z.string(),
        origin: z.enum(['hubspot', 'kit_split', 'manual']),
        parent_line_key: z.string().nullable(),
        hs_line_item_id: z.string().nullable(),
        hs_product_id: z.string().nullable(),
        sku: z.string(),
        xero_item_code: z.string(),
        account_code: z.string(),
        name: z.string(),
        description: z.string(),
        quantity: z.string(),
        unit_price: z.string(),
        discount_percentage: z.string(),
        is_shipping: z.boolean(),
        ship_from_depot: z.enum(['US-BAL', 'US-SBD']),
        ship_from_locked: z.boolean(),
        tax_amount: z.string(),
        tax_override: z.boolean(),
        tracking: z.array(
          z.object({
            categoryId: z.string(),
            categoryName: z.string(),
            optionId: z.string(),
            optionName: z.string(),
          }),
        ),
      }),
    )
    .max(80),
})

export type InvoiceEditorDraft = z.infer<typeof invoiceEditorDraftSchema>

export function parseInvoiceEditorDraft(raw: unknown): InvoiceEditorDraft | null {
  const parsed = invoiceEditorDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
