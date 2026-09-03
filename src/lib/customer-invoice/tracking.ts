/**
 * Xero tracking categories on an invoice line.
 *
 * Shapes taken from Xero's own OpenAPI specification rather than from prose:
 * https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml
 *
 *   TrackingCategory  { TrackingCategoryID, Name, Status, Options[] }
 *   TrackingOption    { TrackingOptionID, Name, Status, TrackingCategoryID }
 *   LineItemTracking  { TrackingCategoryID, TrackingOptionID, Name, Option }
 *
 * And the limit, verbatim from the LineItem.Tracking description: "Any LineItem
 * can have a maximum of 2 <TrackingCategory> elements."
 *
 * Stored in our own camelCase shape and translated at the boundary, so Xero's
 * casing does not leak into the database or the UI.
 */

/** Xero's documented ceiling on tracking elements per line item. */
export const MAX_TRACKING_PER_LINE = 2

/** One category as the Hub holds it, with only its usable options. */
export interface TrackingCategory {
  categoryId: string
  name: string
  options: { optionId: string; name: string }[]
}

/** One selection on one line. Both the ids and the names are kept: the ids are
 *  what Xero matches on, the names are what a human reads on screen and in the
 *  audit log without another lookup. */
export interface LineTracking {
  categoryId: string
  categoryName: string
  optionId: string
  optionName: string
}

interface RawOption {
  TrackingOptionID?: unknown
  Name?: unknown
  Status?: unknown
}

interface RawCategory {
  TrackingCategoryID?: unknown
  Name?: unknown
  Status?: unknown
  Options?: unknown
}

function str(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Xero's GET /TrackingCategories response, narrowed to what a picker needs.
 *
 * ARCHIVED and DELETED are dropped at both levels. Xero keeps them so historical
 * transactions still resolve, but offering one would let a rep tag a new invoice
 * with a category the organisation has retired, and Xero rejects that on the
 * way in rather than at the point of choosing.
 */
export function parseTrackingCategories(payload: unknown): TrackingCategory[] {
  const raw = Array.isArray(payload) ? payload : []
  return raw
    .map((entry) => entry as RawCategory)
    .filter((c) => str(c.Status).toUpperCase() === 'ACTIVE')
    .map((c) => ({
      categoryId: str(c.TrackingCategoryID),
      name: str(c.Name),
      options: (Array.isArray(c.Options) ? (c.Options as RawOption[]) : [])
        .filter((o) => str(o.Status).toUpperCase() === 'ACTIVE')
        .map((o) => ({ optionId: str(o.TrackingOptionID), name: str(o.Name) }))
        .filter((o) => o.optionId !== '' && o.name !== ''),
    }))
    .filter((c) => c.categoryId !== '' && c.name !== '')
}

/** Whatever is in the `tracking` column, read back safely. The column is jsonb
 *  and typed `unknown` on the row, and a malformed entry must not throw inside
 *  a page render or a PDF. */
export function parseLineTracking(value: unknown): LineTracking[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      categoryId: str(entry.categoryId),
      categoryName: str(entry.categoryName),
      optionId: str(entry.optionId),
      optionName: str(entry.optionName),
    }))
    .filter((t) => t.categoryId !== '' && t.optionId !== '')
    .slice(0, MAX_TRACKING_PER_LINE)
}

/**
 * One line's selection, translated into what Xero's LineItem.Tracking expects.
 *
 * Both the ids and the names are sent. Xero accepts either pairing, and sending
 * both means a category renamed in Xero still matches on its id while the
 * payload stays readable in an n8n execution log.
 */
export function toXeroTracking(tracking: readonly LineTracking[]): {
  TrackingCategoryID: string
  TrackingOptionID: string
  Name: string
  Option: string
}[] {
  return tracking.slice(0, MAX_TRACKING_PER_LINE).map((t) => ({
    TrackingCategoryID: t.categoryId,
    TrackingOptionID: t.optionId,
    Name: t.categoryName,
    Option: t.optionName,
  }))
}

/**
 * Apply a rep's choice for one category to a line, replacing any previous
 * choice for that same category and dropping it entirely when they pick blank.
 *
 * Keyed on the category so a line can never end up holding two options from the
 * same category, which Xero rejects.
 */
export function setLineTracking(
  current: readonly LineTracking[],
  category: TrackingCategory,
  optionId: string,
): LineTracking[] {
  const others = current.filter((t) => t.categoryId !== category.categoryId)
  const option = category.options.find((o) => o.optionId === optionId)
  if (!option) return others.slice(0, MAX_TRACKING_PER_LINE)
  return [
    ...others,
    { categoryId: category.categoryId, categoryName: category.name, optionId: option.optionId, optionName: option.name },
  ].slice(0, MAX_TRACKING_PER_LINE)
}
