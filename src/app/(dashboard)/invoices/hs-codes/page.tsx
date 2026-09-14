import { requireCapability } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import { INVOICE_LEGS, isInvoiceLeg, type InvoiceLeg } from '@/lib/invoice-legs'
import HsCodesClient, { type HsCodeProduct } from './hs-codes-client'

export const dynamic = 'force-dynamic'

/**
 * HS codes, one per product per invoice leg.
 *
 * Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro to
 * group and group to depots". Generation fills each invoice line from these, and
 * an invoice with a blank code cannot be issued. Juraj enters the codes here.
 *
 * invoice.view to see, invoice.create to change (the save action checks again).
 *
 * One row per product a container line can carry: every SKU with an
 * intercompany price, plus every active po_product_catalog SKU. A catalogue
 * product with no transfer price still lands on an invoice (valued at 0), so it
 * still needs a code, and listing only priced SKUs left it with no way to get one.
 *
 * A missing code only counts against a leg the product has an active
 * intercompany price on. The other cells stay editable but are not counted, so
 * the Canada column does not ask for codes for products never sold to Canada.
 */
export default async function HsCodesPage() {
  const auth = await requireCapability('invoice.view')
  const canEdit = auth.capabilities.has('invoice.create')

  const supabase = await createServerClient()
  // intercompany_prices is readable only with cost.view, which an HS code
  // editor may not hold. This reads which SKU is priced on which leg and
  // nothing else, never a value, so it goes through the service role after the
  // invoice.view check.
  const admin = createAdminClient()

  const [{ data: priceRows, error: priceErr }, { data: catalogRows, error: catalogErr }, { data: hsRows, error: hsErr }] =
    await Promise.all([
      admin.from('intercompany_prices').select('sku, leg, active'),
      supabase.from('po_product_catalog').select('sku, product_name, active'),
      supabase.from('product_hs_codes').select('sku, leg, hs_code'),
    ])

  const loadError =
    priceErr || catalogErr || hsErr ? 'Could not load the products or their HS codes. Reload the page to try again.' : null

  const prices = (priceRows ?? []) as { sku: string; leg: string; active: boolean }[]
  const catalog = (catalogRows ?? []) as { sku: string; product_name: string | null; active: boolean }[]

  const skus = [
    ...new Set([...prices.map((r) => r.sku), ...catalog.filter((r) => r.active).map((r) => r.sku)]),
  ].sort()

  const nameBySku = new Map(catalog.map((r) => [r.sku, r.product_name]))
  const pricedLegsBySku = new Map<string, InvoiceLeg[]>()
  for (const row of prices) {
    if (!row.active || !isInvoiceLeg(row.leg)) continue
    const legs = pricedLegsBySku.get(row.sku) ?? []
    if (!legs.includes(row.leg)) legs.push(row.leg)
    pricedLegsBySku.set(row.sku, legs)
  }
  const codesBySku = new Map<string, Record<InvoiceLeg, string>>()
  for (const row of (hsRows ?? []) as { sku: string; leg: string; hs_code: string }[]) {
    if (!isInvoiceLeg(row.leg)) continue
    const codes = codesBySku.get(row.sku) ?? emptyCodes()
    codes[row.leg] = row.hs_code
    codesBySku.set(row.sku, codes)
  }

  const products: HsCodeProduct[] = skus.map((sku) => ({
    sku,
    product_name: nameBySku.get(sku) ?? null,
    codes: codesBySku.get(sku) ?? emptyCodes(),
    pricedLegs: INVOICE_LEGS.filter((leg) => pricedLegsBySku.get(sku)?.includes(leg)),
  }))

  return <HsCodesClient products={loadError ? [] : products} canEdit={canEdit} loadError={loadError} />
}

function emptyCodes(): Record<InvoiceLeg, string> {
  return Object.fromEntries(INVOICE_LEGS.map((leg) => [leg, ''])) as Record<InvoiceLeg, string>
}
