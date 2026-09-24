'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { landedCostTarget } from '@/lib/transport/landed-cost.server'

/**
 * Typing the landed cost: Group's commercial invoices with what each product is on, and the
 * customs and delivery costs as a draft until Nippon's bill is read.
 *
 * EVERY export of a 'use server' file is a callable endpoint, so each one asks landedCostTarget
 * (transport.view, cost.view, and the shipment's own organisation or Group) before it writes, and
 * trusts nothing the page sent but ids, keys and typed figures.
 */

type Result = { success: true; message: string } | { success: false; error: string }

const TargetSchema = z.union([
  z.object({ spotId: z.string().regex(/^[0-9]{6,12}$/) }),
  z.object({ id: z.string().uuid() }),
])

const money = z.number().finite().min(0, 'An amount is not below zero.').max(100_000_000)
const optionalMoney = money.nullish().transform((v) => v ?? null)
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = (v ?? '').trim()
      return t ? t : null
    })
const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .transform((v) => v ?? null)

const InvoiceSchema = z.object({
  key: z.string().min(1).max(60),
  id: z.string().uuid().nullish().transform((v) => v ?? null),
  number: z.string().trim().min(1, 'Every invoice needs its number.').max(40),
  invoiceDate: optionalDate,
  supplier: optionalText(120),
  currency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  rate: z.number().finite().positive('A rate is more than nothing.').max(1000).nullish().transform((v) => v ?? null),
  palletising: money,
  delivery: money,
  insurance: money,
  otherAmount: money,
  otherLabel: optionalText(80),
})

const InvoicesInput = z
  .object({
    target: TargetSchema,
    invoices: z.array(InvoiceSchema).max(20, 'Twenty invoices is the most one shipment takes.'),
    lines: z
      .array(
        z.object({
          id: z.string().uuid(),
          invoiceKey: z.string().max(60).nullish().transform((v) => v || null),
          goodsAmount: optionalMoney,
        }),
      )
      .max(40),
  })
  .superRefine((input, ctx) => {
    const numbers = input.invoices.map((i) => i.number.toUpperCase())
    if (new Set(numbers).size !== numbers.length) ctx.addIssue({ code: 'custom', message: 'The same invoice number is there twice.' })
    const keys = new Set(input.invoices.map((i) => i.key))
    if (keys.size !== input.invoices.length) ctx.addIssue({ code: 'custom', message: 'An invoice was sent twice.' })
    if (input.lines.some((l) => l.invoiceKey && !keys.has(l.invoiceKey))) {
      ctx.addIssue({ code: 'custom', message: 'A product is on an invoice that is not in the list.' })
    }
  })

export async function saveLandedInvoices(input: unknown): Promise<Result> {
  const parsed = InvoicesInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Something on the invoices is not valid.' }
  const gate = await landedCostTarget(parsed.data.target)
  if (!gate.ok) return { success: false, error: gate.error }

  const { error } = await createAdminClient().rpc('transport_save_landed_invoices', {
    p_shipment_id: gate.shipmentId,
    p_invoices: parsed.data.invoices.map((i) => ({
      key: i.key,
      id: i.id ?? '',
      invoice_number: i.number,
      invoice_date: i.invoiceDate ?? '',
      supplier: i.supplier ?? '',
      currency: i.currency,
      fx_rate: i.rate ?? '',
      palletising: i.palletising,
      delivery: i.delivery,
      insurance: i.insurance,
      other_amount: i.otherAmount,
      other_label: i.otherLabel ?? '',
    })),
    p_lines: parsed.data.lines.map((l) => ({
      id: l.id,
      invoice_key: l.invoiceKey ?? '',
      goods_amount: l.goodsAmount ?? '',
    })),
    p_user: gate.uid,
  })
  if (error) {
    if (error.code === '23505') return { success: false, error: 'That invoice number is already on this shipment.' }
    return { success: false, error: 'The invoices could not be saved.' }
  }
  revalidatePath(`/transport/${gate.key}`)
  return { success: true, message: 'Invoices saved.' }
}

const LocalInput = z.object({
  target: TargetSchema,
  costs: z.object({
    duty: optionalMoney,
    mpf: optionalMoney,
    hmf: optionalMoney,
    disbursement: optionalMoney,
    clearance: optionalMoney,
    containerDelivery: optionalMoney,
    other: optionalMoney,
    otherLabel: optionalText(80),
    journalDate: optionalDate,
    notes: optionalText(2000),
  }),
})

export async function saveLocalCosts(input: unknown): Promise<Result> {
  const parsed = LocalInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Something on the form is not valid.' }
  const gate = await landedCostTarget(parsed.data.target)
  if (!gate.ok) return { success: false, error: gate.error }

  const c = parsed.data.costs
  const { error } = await createAdminClient()
    .from('transport_shipment_cost')
    .upsert(
      {
        shipment_id: gate.shipmentId,
        duty: c.duty,
        mpf: c.mpf,
        hmf: c.hmf,
        disbursement: c.disbursement,
        clearance: c.clearance,
        container_delivery: c.containerDelivery,
        other_amount: c.other,
        other_label: c.otherLabel,
        journal_date: c.journalDate,
        notes: c.notes,
        updated_by: gate.uid,
      },
      { onConflict: 'shipment_id' },
    )
  if (error) return { success: false, error: 'The costs could not be saved.' }
  revalidatePath(`/transport/${gate.key}`)
  return { success: true, message: 'Saved.' }
}
