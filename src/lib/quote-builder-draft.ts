/**
 * What the quote builder remembers between visits.
 *
 * The cart's numeric fields are held as free-text STRINGS in the form (a box
 * has to be clearable, and holding them as numbers is what produced "0200"),
 * so the draft stores them exactly as typed rather than round-tripping through
 * Number and handing the rep back something they did not write.
 *
 * `LineItem` lives here rather than in the form so the shape the form uses and
 * the shape that gets stored are one declaration. A field added to the cart
 * without adding it here would silently not survive a page change, which is
 * exactly the bug this whole feature exists to fix.
 */

import { z } from 'zod'
import type { DiscountMode } from '@/lib/pricing'

export interface LineItem {
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
  /** What the rep typed into the Unit box, verbatim. Held separately from the
   *  discount so the field is never rewritten mid-edit; it is converted into a
   *  discount by applyTypedPrice at pricing time. */
  priceDraft?: string
}

/** A cart this long is a mistake, not a quote. Caps what one page can store
 *  well below the table's own 64KB limit. */
const MAX_LINES = 200

const lineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  sku: z.string().optional(),
  description: z.string().optional(),
  quantity: z.string(),
  unitPrice: z.string(),
  discountMode: z.enum(['percent', 'amount']).optional(),
  discountValue: z.string().optional(),
  priceDraft: z.string().optional(),
})

const setupSchema = z.object({
  distributor: z.string(),
  depot: z.string(),
  template: z.string(),
  winProbability: z.string(),
  repAgent: z.string(),
  isCollection: z.boolean(),
})

export const quoteBuilderDraftSchema = z.object({
  v: z.literal(1),
  /** Setup was answered, so the dialog does not re-ask. This single flag is the
   *  fix for the complaint that started this: the answers were never anywhere
   *  but React state, so every arrival looked like a first arrival. */
  setupDone: z.boolean(),
  setup: setupSchema,
  lines: z.array(lineSchema).max(MAX_LINES),
  comments: z.string(),
})

export type QuoteBuilderDraft = z.infer<typeof quoteBuilderDraftSchema>
export type QuoteBuilderSetup = z.infer<typeof setupSchema>

/** Anything unreadable is treated as "no draft", never as an error: it was
 *  written by this user's own browser, possibly by an older build. */
export function parseQuoteBuilderDraft(raw: unknown): QuoteBuilderDraft | null {
  const parsed = quoteBuilderDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Is there anything here worth coming back to?
 *
 * Opening the builder and leaving must NOT leave a draft behind, or the deal
 * page would offer to resume an empty cart. Answering setup counts, because
 * that is a decision the rep made and does not want to make twice.
 */
export function isQuoteDraftEmpty(draft: QuoteBuilderDraft): boolean {
  return !draft.setupDone && draft.lines.length === 0 && draft.comments.trim() === ''
}

/**
 * The page key for one deal's builder.
 *
 * An edit gets its own key: a recalled quote is a different piece of work from
 * a new one on the same deal, and mixing them would republish the wrong cart.
 */
export function quoteBuilderKey(dealId: string, dealQuoteId?: string | null): string {
  return dealQuoteId ? `quote-builder:${dealId}:edit:${dealQuoteId}` : `quote-builder:${dealId}`
}

/**
 * A fingerprint of what the builder was opened ON.
 *
 * If the deal's HubSpot line items change while a draft is parked, the draft is
 * still the rep's own work and is still restored, but the strip says the deal
 * moved on. It matters because publishing REPLACES the deal's line items, so a
 * rep resuming a week-old cart should know it will overwrite whatever is there
 * now.
 */
export function quoteBuilderBase(
  initialLineItems: readonly { properties: { hs_product_id?: string; quantity?: string | number | null; price?: string | number | null } }[],
  dealQuoteId?: string | null,
): string {
  const items = initialLineItems
    .map((i) => `${i.properties.hs_product_id ?? ''}:${i.properties.quantity ?? ''}:${i.properties.price ?? ''}`)
    .sort()
  return JSON.stringify({ items, editing: dealQuoteId ?? null })
}
