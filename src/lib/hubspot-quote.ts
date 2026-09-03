/**
 * The request bodies for a real HubSpot Quote object.
 *
 * Phase B retires the jsPDF quote the Hub rendered and uploaded to HubSpot
 * Files. The rep now gets HubSpot's own hosted quote and its public link, so
 * the Hub has to build a create body HubSpot accepts first time: the
 * quote-to-template association CAN ONLY BE SET AT CREATION, which is the one
 * reason the whole body is assembled in a single request rather than created
 * and then associated. A body that misses it produces a quote that can never
 * be published and has to be deleted by hand in the portal.
 *
 * Endpoint: POST /crm/v3/objects/quotes, the legacy v3 quotes API. That is the
 * object type this portal already produces (1657 existing quotes, every one of
 * them hs_template_type CUSTOMIZABLE_QUOTE_TEMPLATE). The newer 2026-03 CPQ
 * quotes API needs Revenue Hub seats this account does not have.
 *
 * Everything here is pure, so the wire format is asserted in vitest without
 * touching the live CRM. Any "today" is a parameter for the same reason.
 */

import { roundCents, toMoney } from '@/lib/quote-math'

/**
 * HUBSPOT_DEFINED association type ids, confirmed against a live published
 * quote in this portal.
 *
 * A wrong id does not error. HubSpot accepts the write and the quote renders
 * with no line items, or no company, or refuses to publish, so these are pinned
 * in one place and guarded by a test rather than retyped per call site.
 */
export const QUOTE_ASSOCIATION_TYPE_IDS = {
  template: 286,
  deal: 64,
  lineItem: 67,
  contact: 69,
  company: 71,
  // The signer is a SECOND association to the same contact, needed only once
  // e-signature is switched on. Kept here so the id is not re-derived then.
  signer: 702,
} as const

/** House default, matching the expiry the old PDF printed. */
export const QUOTE_EXPIRY_DAYS = 60

export const QUOTE_PUBLISHED_STATUS = 'APPROVAL_NOT_NEEDED'
export const QUOTE_DRAFT_STATUS = 'DRAFT'

/**
 * The properties to read back after the publish PATCH.
 *
 * hs_quote_link only exists once the status change has published the quote, so
 * this read is the step that produces the link handed to the rep.
 */
export const QUOTE_READBACK_PROPERTIES: readonly string[] = [
  'hs_title',
  'hs_status',
  'hs_expiration_date',
  'hs_quote_number',
  'hs_quote_amount',
  'hs_currency',
  'hs_quote_link',
  'hs_pdf_download_link',
]

const MS_PER_DAY = 86_400_000

/**
 * yyyy-mm-dd to a UTC Date, or null when it is not a real calendar date.
 *
 * Date.UTC ROLLS OVER instead of failing, so '2026-13-45' becomes a plausible
 * date well into the following year and an expiry silently lands months out.
 * Round-tripping the components is the same guard, for the same reason, as
 * toUTC in customer-invoice/payment-terms.ts.
 */
function parseYmd(value: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(d.getTime())) return null
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return d
}

/**
 * yyyy-mm-dd, `days` after the yyyy-mm-dd handed in. Pure: today is a
 * parameter, so the expiry a test asserts is the expiry the rep gets.
 *
 * Throws rather than returning a wrong date. hs_expiration_date is required and
 * a quote that expires in the past cannot be sent, so a bad input has to stop
 * the write instead of reaching the customer.
 */
export function quoteExpiryDate(today: string, days: number = QUOTE_EXPIRY_DAYS): string {
  const base = parseYmd(today)
  if (!base) throw new Error(`quoteExpiryDate needs a real yyyy-mm-dd date, got '${today}'`)
  if (!Number.isFinite(days)) throw new Error(`quoteExpiryDate needs a finite day count, got '${days}'`)
  // Fixed-length days are safe here only because both ends are UTC, which has
  // no daylight saving jump to swallow or duplicate an hour.
  return new Date(base.getTime() + Math.trunc(days) * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Ampersand first, or every entity below it gets escaped a second time. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The rep's free text as the HTML hs_comments actually holds.
 *
 * hs_comments is rendered as HTML on the customer-facing quote, so raw text
 * loses its line breaks and any angle bracket the rep typed becomes markup.
 * One <p style="margin:0;"> per line is what the portal's own editor stores,
 * so a quote built here and a quote edited in HubSpot look the same.
 */
export function commentsToHtml(text: string | null | undefined): string {
  const raw = String(text ?? '')
  if (raw.trim() === '') return ''
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="margin:0;">${escapeHtml(line)}</p>`)
    .join('')
}

/**
 * EBUS26123 for the first quote on a deal, EBUS26123-2 for the second.
 *
 * hs_quote_number is one of the few HubSpot-generated fields that IS settable:
 * the guide says it is "set based on the current date and time, unless one is
 * provided". Providing the Hub's own reference puts a single number on the
 * quote, the deal and the Xero invoice. The suffix exists because regenerating
 * creates a NEW quote object rather than editing the published one, and two
 * live quotes carrying the same number is what the rep would otherwise send.
 *
 * Returns undefined for a blank reference so the caller omits the property
 * entirely and lets HubSpot number it.
 */
export function nextQuoteNumber(quoteReference: string | null | undefined, existingCount: number): string | undefined {
  const ref = String(quoteReference ?? '').trim()
  if (ref === '') return undefined
  const count = Number.isFinite(existingCount) ? Math.max(0, Math.trunc(existingCount)) : 0
  return count > 0 ? `${ref}-${count + 1}` : ref
}

export interface QuoteLineItemInput {
  name: string
  quantity: number
  price: number
  hs_discount_percentage?: number
  discount?: number
  hs_product_id?: string | null
  hs_sku?: string | null
  description?: string | null
}

export interface QuoteLineItemSource {
  name?: string | null
  quantity?: number | string
  price?: number | string
  hs_discount_percentage?: number | null
  discount?: number | null
  hs_product_id?: string | null
  hs_sku?: string | null
  description?: string | null
}

/**
 * Omit rather than send an empty string. HubSpot treats '' as a real value and
 * it OVERWRITES what the quote would otherwise inherit from the template or the
 * associated deal.
 */
function setIfPresent(target: Record<string, string>, key: string, value: string | null | undefined): void {
  const v = String(value ?? '').trim()
  if (v !== '') target[key] = v
}

function normaliseLine(line: QuoteLineItemSource): QuoteLineItemInput {
  const percentage = roundCents(toMoney(line.hs_discount_percentage))
  const perUnit = roundCents(toMoney(line.discount))
  return {
    name: String(line.name ?? '').trim(),
    // A missing or fractional quantity must not reach the wire: HubSpot derives
    // the line amount as price x quantity, so a 0 there is a free line on a
    // quote the customer sees. A wrong whole number is at least visible.
    quantity: Math.max(1, Math.round(toMoney(line.quantity))),
    price: roundCents(toMoney(line.price)),
    // HubSpot applies hs_discount_percentage and discount BOTH when both are
    // present, stacking them, so the two are mutually exclusive. Percentage
    // wins because that is what the builder's discount control produces.
    hs_discount_percentage: percentage > 0 ? percentage : undefined,
    discount: percentage <= 0 && perUnit > 0 ? perUnit : undefined,
  }
}

/**
 * The inputs array for POST /crm/v3/objects/line_items/batch/create.
 *
 * These are COPIES, never the deal's own line items. The guide is explicit:
 * "Line items associated with a quote should be distinct from the line items
 * associated with the quote's deal (i.e., you should create copies of the line
 * items)." Sharing them makes an edit on the quote rewrite the deal.
 *
 * Every HubSpot property value is a string on the wire, so money is serialised
 * at two decimals and quantity as a whole number here rather than left to
 * JSON.stringify.
 */
export function buildQuoteLineItemInputs(
  lines: readonly QuoteLineItemSource[],
  currency?: string | null,
): { properties: Record<string, string> }[] {
  const currencyCode = String(currency ?? '').trim().toUpperCase()
  return lines.map((line, index) => {
    const item = normaliseLine(line)
    const properties: Record<string, string> = {
      name: item.name,
      quantity: String(item.quantity),
      price: item.price.toFixed(2),
      // Cart order is the order the rep built the quote in. Without an explicit
      // position HubSpot renders line items in creation order, which the batch
      // endpoint does not guarantee it preserves.
      hs_position_on_quote: String(index),
    }
    // Named explicitly, never inherited. These line items are created STANDALONE
    // and associated afterwards, and an unattached line item falls back to the
    // portal's company currency, which is EUR on this account. A USD quote whose
    // lines say EUR is a wrong number in front of a customer.
    if (currencyCode !== '') properties.hs_line_item_currency_code = currencyCode
    if (item.hs_discount_percentage !== undefined) {
      properties.hs_discount_percentage = String(item.hs_discount_percentage)
    } else if (item.discount !== undefined) {
      properties.discount = item.discount.toFixed(2)
    }
    setIfPresent(properties, 'hs_product_id', line.hs_product_id)
    setIfPresent(properties, 'hs_sku', line.hs_sku)
    setIfPresent(properties, 'description', line.description)
    return { properties }
  })
}

export interface QuoteCreateInput {
  title: string
  expirationDate: string
  quoteNumber?: string
  comments?: string | null
  sender?: { firstname?: string | null; lastname?: string | null; email?: string | null; phone?: string | null }
  templateId?: string | null
  dealId: string
  /**
   * Normally EMPTY. The Hub creates the quote first and its line items second,
   * so that the likeliest failure (a rejected create) happens before any line
   * item exists and a later failure leaves a visible DRAFT on the deal rather
   * than orphaned line items attached to nothing. Line items are associated
   * afterwards through the v4 batch endpoint with the same type id 67. Kept
   * here because a caller that already holds the ids may still inline them.
   */
  lineItemIds?: readonly string[]
  contactId?: string | null
  companyId?: string | null
}

export interface QuoteCreateBody {
  properties: Record<string, string>
  associations: { to: { id: string }; types: { associationCategory: 'HUBSPOT_DEFINED'; associationTypeId: number }[] }[]
}

/**
 * The body for POST /crm/v3/objects/quotes.
 *
 * Deliberately NOT sent, because HubSpot computes or inherits each of them and
 * any value we pass is overridden or, worse, sticks and diverges from the deal:
 *   hubspot_owner_id   calculated from the associated deal's owner
 *   hs_domain, hs_locale, hs_language   inherited from the quote template
 *   hs_currency        inherited from the associated deal
 *   hs_quote_link, hs_pdf_download_link, hs_locked, hs_quote_amount   generated
 *   hs_template_type   HubSpot sets it to CUSTOMIZABLE_QUOTE_TEMPLATE on the
 *                      state change, as the guide says explicitly
 */
export function buildQuoteCreateBody(input: QuoteCreateInput): QuoteCreateBody {
  const properties: Record<string, string> = {
    hs_title: String(input.title ?? '').trim(),
    hs_expiration_date: String(input.expirationDate ?? '').trim(),
    // Sent at CREATION on purpose. The guide: "If not provided at creation,
    // users will not be able to edit the quote in HubSpot." Publishing is a
    // separate PATCH to APPROVAL_NOT_NEEDED, which "publishes the quote at a
    // publicly accessible URL (hs_quote_link)".
    hs_status: QUOTE_DRAFT_STATUS,
  }

  setIfPresent(properties, 'hs_quote_number', input.quoteNumber)

  const comments = commentsToHtml(input.comments)
  if (comments !== '') properties.hs_comments = comments

  setIfPresent(properties, 'hs_sender_firstname', input.sender?.firstname)
  setIfPresent(properties, 'hs_sender_lastname', input.sender?.lastname)
  setIfPresent(properties, 'hs_sender_email', input.sender?.email)
  setIfPresent(properties, 'hs_sender_phone', input.sender?.phone)

  const associations: QuoteCreateBody['associations'] = []
  const associate = (id: string | null | undefined, associationTypeId: number) => {
    const to = String(id ?? '').trim()
    if (to === '') return
    associations.push({ to: { id: to }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }] })
  }

  // Template first, and only here: this association cannot be added afterwards.
  associate(input.templateId, QUOTE_ASSOCIATION_TYPE_IDS.template)
  associate(input.dealId, QUOTE_ASSOCIATION_TYPE_IDS.deal)
  for (const lineItemId of input.lineItemIds ?? []) {
    associate(lineItemId, QUOTE_ASSOCIATION_TYPE_IDS.lineItem)
  }
  associate(input.contactId, QUOTE_ASSOCIATION_TYPE_IDS.contact)
  associate(input.companyId, QUOTE_ASSOCIATION_TYPE_IDS.company)

  return { properties, associations }
}

/**
 * Run before any write. Returns a sentence to show the rep, or null when the
 * quote can be built.
 *
 * lineCount is the size of the cart, passed separately because the Hub creates
 * the quote before its line items and therefore has no ids to check yet.
 *
 * templateId and companyId are NOT refused, both are optional per the guide.
 * Note that a quote with no template still cannot be published, and the
 * association cannot be added later, so the caller should resolve a default
 * template rather than rely on this passing.
 */
export function validateQuoteInput(input: QuoteCreateInput, lineCount = 0): string | null {
  if (String(input.title ?? '').trim() === '') {
    return 'Give the quote a title before generating it.'
  }
  if (!parseYmd(input.expirationDate)) {
    return 'Set a real expiry date (yyyy-mm-dd) before generating the quote.'
  }
  if (String(input.dealId ?? '').trim() === '') {
    return 'This quote is not attached to a deal, so HubSpot cannot build it.'
  }
  const lines = input.lineItemIds?.length ? input.lineItemIds.length : lineCount
  if (!Number.isFinite(lines) || lines < 1) {
    return 'Add at least one line item before generating a quote.'
  }
  if (String(input.contactId ?? '').trim() === '') {
    return 'Add a contact to the deal before generating a quote.'
  }
  return null
}
