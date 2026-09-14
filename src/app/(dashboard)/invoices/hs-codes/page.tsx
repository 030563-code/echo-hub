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
 * One row per product that has an intercompany price on any leg.
 */
export default async function HsCodesPage() {
  const auth = await requireCapability('invoice.view')
  const canEdit = auth.capabilities.has('invoice.create')

  const supabase = await createServerClient()
  // intercompany_prices is readable only with cost.view, which an HS code
  // editor may not hold. This reads the SKU column and nothing else, never a
  // value, so it goes through the service role after the invoice.view check.
  const admin = createAdminClient()

  const [{ data: priceRows, error: priceErr }, { data: hsRows, error: hsErr }] = await Promise.all([
    admin.from('intercompany_prices').select('sku'),
    supabase.from('product_hs_codes').select('sku, leg, hs_code'),
  ])

  const skus = [...new Set(((priceRows ?? []) as { sku: string }[]).map((r) => r.sku))].sort()
  const { data: nameRows, error: nameErr } = skus.length
    ? await supabase.from('po_product_catalog').select('sku, product_name').in('sku', skus)
    : { data: [], error: null }

  const loadError = priceErr || hsErr || nameErr ? 'Could not load the products or their HS codes. Reload the page to try again.' : null

  const nameBySku = new Map(((nameRows ?? []) as { sku: string; product_name: string | null }[]).map((r) => [r.sku, r.product_name]))
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
  }))

  return <HsCodesClient products={loadError ? [] : products} canEdit={canEdit} loadError={loadError} />
}

function emptyCodes(): Record<InvoiceLeg, string> {
  return Object.fromEntries(INVOICE_LEGS.map((leg) => [leg, ''])) as Record<InvoiceLeg, string>
}
