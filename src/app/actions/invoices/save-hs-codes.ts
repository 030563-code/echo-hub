'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { INVOICE_LEGS, type InvoiceLeg } from '@/lib/invoice-legs'
import { isValidHsCode, normaliseHsCode } from '@/lib/hs-codes'

// Saves one product's HS codes, one per invoice leg, from /invoices/hs-codes.
//
// Every export of a 'use server' file is a public endpoint, so this checks
// everything itself: a session, the invoice.create capability, the shape of the
// input, and that the SKU really is a product with an intercompany price.
// product_hs_codes has no write policy, so the writes go through the service-role
// client, and only after all of that.
//
// A code is normalised (trimmed, whitespace collapsed) and must pass
// isValidHsCode, the same rule as the table's CHECK. A blank code deletes that
// product's row for that leg. Codes reach invoices generated after the save; an
// existing draft keeps its lines until it is edited.

const HS_CODE_MESSAGE = 'An HS code is 6 to 10 digits, split by single dots or spaces, e.g. 3926.90 or 3926 90 97.'

const code = z
  .string()
  .max(40, HS_CODE_MESSAGE)
  .transform(normaliseHsCode)
  .refine((v) => v === '' || isValidHsCode(v), { message: HS_CODE_MESSAGE })

const codesShape = {
  SRO_TO_GROUP: code,
  GROUP_TO_USA: code,
  GROUP_TO_CANADA: code,
} satisfies Record<InvoiceLeg, typeof code>

const Schema = z.object({
  sku: z.string().trim().min(1).max(120),
  codes: z.object(codesShape).strict(),
})

export type SaveHsCodesResult = { ok: true; codes: Record<InvoiceLeg, string> } | { ok: false; error: string }

export async function saveHsCodes(input: z.input<typeof Schema>): Promise<SaveHsCodesResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('invoice.create')) {
    return { ok: false, error: 'Changing HS codes needs the invoice.create capability.' }
  }

  const parsed = Schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { sku, codes } = parsed.data

  const admin = createAdminClient()

  const { data: priced, error: skuErr } = await admin.from('intercompany_prices').select('sku').eq('sku', sku).limit(1)
  if (skuErr) return { ok: false, error: 'Could not check the product, so nothing was saved.' }
  if (!priced?.length) return { ok: false, error: `${sku} has no intercompany price, so it has no HS codes to set.` }

  const now = new Date().toISOString()
  const upserts = INVOICE_LEGS.filter((leg) => codes[leg] !== '').map((leg) => ({
    sku,
    leg,
    hs_code: codes[leg],
    updated_at: now,
  }))
  const cleared = INVOICE_LEGS.filter((leg) => codes[leg] === '')

  if (upserts.length) {
    const { error } = await admin.from('product_hs_codes').upsert(upserts, { onConflict: 'sku,leg' })
    if (error) return { ok: false, error: 'Could not save the HS codes.' }
  }
  if (cleared.length) {
    const { error } = await admin.from('product_hs_codes').delete().eq('sku', sku).in('leg', cleared)
    if (error) {
      return {
        ok: false,
        error: upserts.length
          ? 'Saved the codes you typed, but could not remove the ones you cleared.'
          : 'Could not remove the HS codes.',
      }
    }
  }

  revalidatePath('/invoices', 'layout')
  return { ok: true, codes }
}
