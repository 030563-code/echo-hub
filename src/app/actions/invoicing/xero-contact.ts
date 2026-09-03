'use server'

/**
 * The Xero customer behind an invoice: look it up by account number, and
 * create or edit it without leaving the Hub.
 *
 * Xero is the source of truth here, not us. The contact carries the billing
 * address, the accounts-payable email the invoice is sent to, and the payment
 * terms the due date is derived from, so it is read live rather than copied
 * into our schema and left to drift.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { requireInvoicingManage } from '@/app/actions/invoicing/shared'
import { xeroFindContact, xeroSaveContact, type XeroContact } from '@/lib/xero-hub'

const AccountNumber = z.string().trim().min(1).max(64)

const SaveInput = z.object({
  contactId: z.string().trim().min(1).nullable().optional(),
  accountNumber: AccountNumber,
  name: z.string().trim().min(1, 'A company name is required.').max(500),
  email: z.string().trim().max(255).nullable().optional(),
  address: z
    .object({
      line1: z.string().trim().max(500).nullable().optional(),
      line2: z.string().trim().max(500).nullable().optional(),
      city: z.string().trim().max(255).nullable().optional(),
      region: z.string().trim().max(255).nullable().optional(),
      postal_code: z.string().trim().max(50).nullable().optional(),
      country: z.string().trim().max(100).nullable().optional(),
    })
    .nullable()
    .optional(),
  // Xero stores {Day, Type}; three of the four types are month-relative, so the
  // type has to travel with the day or the due date is wrong by weeks.
  paymentTerms: z
    .object({ day: z.number().int().min(0).max(365), type: z.string().trim().min(1).max(40) })
    .nullable()
    .optional(),
})

export type ContactLookupResult =
  | { success: true; found: true; contact: XeroContact }
  | { success: true; found: false }
  | { success: false; error: string }

export type ContactSaveResult = { success: true; contact: XeroContact } | { success: false; error: string }

export async function lookupInvoiceContact(input: { accountNumber: string }): Promise<ContactLookupResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    return { success: false, error: 'Not permitted to view invoicing.' }
  }

  const parsed = AccountNumber.safeParse(input.accountNumber)
  if (!parsed.success) return { success: false, error: 'Enter a Xero account number first.' }

  const res = await xeroFindContact(parsed.data)
  if (!res.ok) return { success: false, error: res.error }
  return res.data ? { success: true, found: true, contact: res.data } : { success: true, found: false }
}

export async function saveInvoiceContact(input: z.input<typeof SaveInput>): Promise<ContactSaveResult> {
  // Writing to Xero needs the manage capability, not just view: this creates or
  // edits a real customer record in the live ledger.
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = SaveInput.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Check the contact details.' }
  }
  const d = parsed.data

  const res = await xeroSaveContact({
    contactId: d.contactId ?? null,
    accountNumber: d.accountNumber,
    name: d.name,
    email: d.email?.trim() || null,
    address: d.address ?? null,
    paymentTerms: d.paymentTerms ?? null,
  })
  if (!res.ok) return { success: false, error: res.error }
  return { success: true, contact: res.data }
}
