/**
 * Staleness detection for draft invoices: a stable hash over exactly the
 * fields that change a tax calculation. Editing a description does not
 * invalidate tax; editing a quantity, price, discount, ship-from depot,
 * delivery address or customer id does.
 */

import { createHash } from 'node:crypto'

export interface TaxRelevantLine {
  line_key: string
  sku: string | null
  quantity: number
  unit_price: number
  discount_percentage: number
  is_shipping: boolean
  ship_from_depot: string
}

export interface TaxRelevantHeader {
  delivery_street: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  taxjar_customer_id: string | null
}

export function linesHash(lines: readonly TaxRelevantLine[], header: TaxRelevantHeader): string {
  const canonical = {
    header: {
      street: header.delivery_street ?? '',
      city: header.delivery_city ?? '',
      state: header.delivery_state ?? '',
      zip: header.delivery_zip ?? '',
      customer: header.taxjar_customer_id ?? '',
    },
    lines: [...lines]
      .sort((a, b) => a.line_key.localeCompare(b.line_key))
      .map((l) => ({
        k: l.line_key,
        s: l.sku ?? '',
        q: l.quantity,
        p: l.unit_price,
        d: l.discount_percentage,
        f: l.is_shipping,
        w: l.ship_from_depot,
      })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Hash of a deal's raw line_items_raw snapshot, for "lines changed on the
 *  deal since this draft was built" detection. Order-sensitive on purpose:
 *  the builder consumes the array in order. */
export function sourceLinesHash(raw: unknown): string {
  return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')
}
