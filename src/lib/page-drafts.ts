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

// ---------------------------------------------------------------------------
// The quotes filter bar, shared by the board, the stage queues and All
//
// These filters already live in the URL, which is right: a filtered view is
// linkable and survives a refresh. What was missing is the bare arrival from
// the sidebar, which threw away a filter set the rep had just built.
// ---------------------------------------------------------------------------

export const QUOTES_FILTERS_KEY = 'quotes:filters'

/**
 * The six routes that own the filter bar, and the ONLY ones allowed to record
 * it.
 *
 * QuotesNav is rendered by the layout that wraps the whole /quotes/* subtree,
 * so without an exact-path test the recorder would also fire on a deal, on the
 * quote builder and on the create wizard. Those carry no filter parameters, so
 * each visit would record an empty set over the filters the rep had just built,
 * and opening a deal is the most common click in the module. The feature would
 * have looked simply broken.
 */
export const QUOTES_LIST_ROUTES = [
  '/quotes/board',
  '/quotes/deals',
  '/quotes/sent',
  '/quotes/accepted',
  '/quotes/won',
  '/quotes/all',
] as const

export function isQuotesListRoute(pathname: string): boolean {
  return (QUOTES_LIST_ROUTES as readonly string[]).includes(pathname)
}

/**
 * The parameters a saved view may put back: every filter the bar owns, plus the
 * three the pages own themselves (which reps and which region, and how far back
 * the board looks). Anything not on this list is ignored on the way out, so a
 * row written by a future version cannot redirect anyone somewhere odd.
 */
export const RESTORABLE_QUOTE_PARAMS = [
  'q',
  'pipeline',
  'stages',
  'owner',
  'depot',
  'amountMin',
  'amountMax',
  'createdFrom',
  'createdTo',
  'company',
  'contact',
  'scope',
  'window',
] as const

export const quotesFiltersSchema = z.object({
  v: z.literal(1),
  params: z.record(z.string().max(40), z.union([z.string().max(200), z.array(z.string().max(200)).max(20)])),
})

export type QuotesFilters = z.infer<typeof quotesFiltersSchema>

export function parseQuotesFilters(raw: unknown): QuotesFilters | null {
  const parsed = quotesFiltersSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Paging belongs to the result set it came from, never to a remembered view.
 * The quotes tab bar already drops these when moving between tabs, for the same
 * reason: page 4 of Sent is meaningless on Won.
 */
export const NEVER_RESTORED_PARAMS = ['page', 'cursors'] as const

/**
 * Turn a saved filter set into a query string, or null when there is nothing
 * worth redirecting for.
 *
 * Pure, so the rule can be tested without a database or a router.
 */
/**
 * Did this URL ask for something specific?
 *
 * A URL carrying any recognised parameter is a deliberate request: a shared
 * link, a bookmark, Clear, or a filter the user just applied. Those are never
 * overridden and never recorded over.
 */
export function hasAnyRestorableParam(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  accepted: readonly string[],
): boolean {
  if (params instanceof URLSearchParams) {
    return accepted.some((name) => (params.get(name) ?? '') !== '')
  }
  return accepted.some((name) => {
    const value = params[name]
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== ''
  })
}

export function pickRestorableParams(
  stored: QuotesFilters | null,
  accepted: readonly string[],
): string | null {
  if (!stored) return null
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(stored.params)) {
    if (!accepted.includes(name)) continue
    if ((NEVER_RESTORED_PARAMS as readonly string[]).includes(name)) continue
    if (Array.isArray(value)) for (const v of value) query.append(name, v)
    else query.set(name, value)
  }
  const out = query.toString()
  return out === '' ? null : out
}

// ---------------------------------------------------------------------------
// The commercial invoice draft editor
//
// Fingerprinted on the lines it was opened against, so edits typed before
// somebody regenerated the invoice are dropped rather than reapplied to a
// different set of lines.
// ---------------------------------------------------------------------------

export function commercialInvoiceKey(invoiceId: string): string {
  return `commercial-invoice:${invoiceId}`
}

export const commercialInvoiceDraftSchema = z.object({
  v: z.literal(1),
  rows: z
    .array(
      z.object({
        sku: z.string(),
        product_name: z.string(),
        // Free text, like every other money box in the Hub, so a half-typed
        // "12." survives the trip.
        qty: z.string(),
        unit_value: z.string(),
        hs_code: z.string(),
      }),
    )
    .max(120),
})

export type CommercialInvoiceDraft = z.infer<typeof commercialInvoiceDraftSchema>

export function parseCommercialInvoiceDraft(raw: unknown): CommercialInvoiceDraft | null {
  const parsed = commercialInvoiceDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
