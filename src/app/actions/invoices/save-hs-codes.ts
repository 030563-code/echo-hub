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
// input, and that the SKU really is a product a container line can carry: one
// with an intercompany price, or one in the active po_product_catalog (a product
// with no transfer price yet still lands on invoices, valued at 0, and still
// needs a code). product_hs_codes has no write policy, so the writes go through
// the service-role client, and only after all of that.
//
// `codes` is PARTIAL: only the legs the screen changed. A leg that is absent is
// left exactly as it is, so saving one row never overwrites a code on another
// leg that somebody saved elsewhere since the page loaded. A leg received blank
// deletes that product's row for that leg.
//
// A code is normalised (trimmed, whitespace collapsed) and must pass
// isValidHsCode, the same rule as the table's CHECK. Codes reach invoices
// generated after the save; an existing draft keeps its lines until it is edited.

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
  // Partial: every leg is optional, and an absent leg is never touched.
  codes: z
    .object(codesShape)
    .partial()
    .strict()
    .refine((c) => INVOICE_LEGS.some((leg) => c[leg] !== undefined), { message: 'Nothing to save: no leg was changed.' }),
})

export type SaveHsCodesResult = { ok: true; codes: Partial<Record<InvoiceLeg, string>> } | { ok: false; error: string }

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

  const [{ data: priced, error: priceErr }, { data: listed, error: catalogErr }] = await Promise.all([
    admin.from('intercompany_prices').select('sku').eq('sku', sku).limit(1),
    admin.from('po_product_catalog').select('sku').eq('sku', sku).eq('active', true).limit(1),
  ])
  if (priceErr || catalogErr) return { ok: false, error: 'Could not check the product, so nothing was saved.' }
  if (!priced?.length && !listed?.length) {
    return { ok: false, error: `${sku} is not a product with an intercompany price or in the product catalogue, so it has no HS codes to set.` }
  }

  const received = INVOICE_LEGS.filter((leg) => codes[leg] !== undefined)
  const now = new Date().toISOString()
  const upserts = received
    .filter((leg) => codes[leg] !== '')
    .map((leg) => ({
      sku,
      leg,
      hs_code: codes[leg] as string,
      updated_at: now,
    }))
  const cleared = received.filter((leg) => codes[leg] === '')

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
  return { ok: true, codes: Object.fromEntries(received.map((leg) => [leg, codes[leg] as string])) }
}
