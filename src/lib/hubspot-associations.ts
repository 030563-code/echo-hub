/**
 * Read a HubSpot object's associated line-item ids, whatever the API decided to
 * call the key this time.
 *
 * HubSpot does not commit to one spelling. Verified live on 2026-09-04 against
 * deal 64665124513: requesting `?associations=line_items` came back with the
 * results under `"line items"`, with a SPACE. The v3 docs show the underscored
 * form and older responses used the singular, so all three are in play.
 *
 * This is not a display detail. `addLineItemsToDeal` archives whatever it finds
 * here before writing the replacement set, so a missed key means it archives
 * nothing and the new lines are APPENDED instead of replacing. The deal then
 * carries the old price and the new one at once and its line-item total is the
 * sum of both, which is exactly what a recalled-and-edited quote produced: a
 * $100 line and a $1,000 line sitting on the same deal.
 *
 * Every spelling is read and de-duplicated, so a response that starts carrying
 * two of them at once cannot make the caller archive the same id twice.
 */
export function lineItemIdsFromAssociations(associations: unknown): string[] {
  if (!associations || typeof associations !== 'object') return []

  const groups = associations as Record<string, { results?: unknown } | undefined>
  const ids: string[] = []

  for (const key of ['line_items', 'line_item', 'line items']) {
    const results = groups[key]?.results
    if (!Array.isArray(results)) continue
    for (const ref of results) {
      const id = (ref as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id.length > 0) ids.push(id)
      else if (typeof id === 'number') ids.push(String(id))
    }
  }

  return Array.from(new Set(ids))
}

/**
 * The association keys to ask HubSpot for. Sent together because the API
 * returns whichever it feels like and ignores the ones it does not know.
 */
export const LINE_ITEM_ASSOCIATION_PARAM = 'line_item,line_items'
