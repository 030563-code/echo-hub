'use server'

/**
 * The packing list, for the office: PL-A on s.r.o. letterhead or PL-B on Group
 * letterhead, built from the signed manufacturing specification.
 *
 * Same gate as the specification document: po.view and the chain held, and no
 * cost.view, because a packing list carries quantities and kilograms and not a
 * single price. The person despatching types the consignee, the date and the
 * factory's pallet counter once; nothing typed here is stored, the document is
 * the record, and the same inputs render the same bytes.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { loadPackingListContext, renderPackingListPdf } from '@/lib/despatch/packing-list-store'

const Party = z.object({
  name: z.string().trim().min(1, 'The consignee needs a name').max(120),
  address: z.array(z.string().trim().max(120)).max(8),
})
const Optional = z.string().trim().max(160).nullable()

const Input = z.object({
  poId: z.string().uuid('Invalid PO id'),
  variant: z.enum(['A', 'B']),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'The date must be yyyy-mm-dd')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'That is not a date'),
  consignee: Party,
  deliverTo: Party,
  attention: z.object({ name: Optional, phone: Optional, email: Optional }),
  incoterms: z.string().trim().max(80).nullable(),
  firstPalletNumber: z.number().int().min(1, 'Pallets are numbered from 1').max(999),
  comments: z.string().trim().max(1000).nullable(),
})

export type PackingListRequest = z.input<typeof Input>

export type PackingListPdfResult =
  | { ok: true; filename: string; base64: string; warnings: string[] }
  | { ok: false; error: string }

export async function downloadPackingList(input: PackingListRequest): Promise<PackingListPdfResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('po.view')) {
    return { ok: false, error: 'Forbidden: missing po.view capability' }
  }
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  if (!(await poChainHeldBy(parsed.data.poId, auth.profile.organisations))) {
    return { ok: false, error: 'That purchase order no longer exists.' }
  }

  const context = await loadPackingListContext(parsed.data.poId)
  if (!context) {
    return { ok: false, error: 'This order has no manufacturing specification to pack from.' }
  }

  const { variant, date, consignee, deliverTo, attention, incoterms, firstPalletNumber, comments } = parsed.data
  const rendered = await renderPackingListPdf(
    context,
    { date, consignee, deliverTo, attention, incoterms, firstPalletNumber, comments },
    variant,
  )
  return { ok: true, ...rendered }
}
