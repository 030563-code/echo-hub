import { formatDate } from '@/lib/utils'

/**
 * The email that carries a customer invoice.
 *
 * Dean's copy, 2026-09-04, verbatim. Kept pure and out of the action so the
 * wording is testable: this is the one piece of writing in the invoicing flow
 * that a customer actually reads, and it goes out with a payable attached.
 *
 * Amounts print WITHOUT a currency symbol, with the code in front of them
 * ("USD 1,297.13"), because that is how Dean wrote it and because a bare $ is
 * ambiguous to a customer who also buys from the Canadian entity.
 */

export interface InvoiceEmailInput {
  /** The person, when we know one. Absent for a Xero contact that carries only
   *  a company name, which is most of them. */
  contactFirstName?: string | null
  invoiceNumber: string | null
  currency: string | null
  total: number | null
  /** What is still owed. Equal to the total for an invoice being issued now,
   *  and passed separately so a part-paid invoice can never say otherwise. */
  amountDue: number | null
  /** ISO date. Rendered US long form, the way every other date in the app now
   *  reads. */
  dueDate: string | null
}

export interface InvoiceEmail {
  subject: string
  body: string
}

/** "1,297.13". Two decimals always: an invoice that says 1,297.1 looks wrong. */
function amount(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

export function buildInvoiceEmail(input: InvoiceEmailInput): InvoiceEmail {
  const first = String(input.contactFirstName ?? '').trim()
  const number = String(input.invoiceNumber ?? '').trim()
  const currency = String(input.currency ?? 'USD').trim().toUpperCase() || 'USD'
  const due = String(input.dueDate ?? '').trim()

  const lines = [
    // "Hi there" rather than a blank or a company name: a Xero contact usually
    // holds only the business, and "Hi Apex Technology, Inc," reads like a
    // mailshot.
    first === '' ? 'Hi there,' : `Hi ${first},`,
    '',
    `Here's invoice ${number} for ${currency} ${amount(input.total)}.`,
    '',
  ]

  // The due-date sentence is dropped rather than printed with a gap when Xero
  // holds no payment terms for the contact. Payment details are on the invoice
  // itself either way.
  if (due !== '') {
    lines.push(
      `The amount outstanding of ${currency} ${amount(input.amountDue)} is due on ${formatDate(due)}.`,
      '',
    )
  } else {
    lines.push(`The amount outstanding is ${currency} ${amount(input.amountDue)}.`, '')
  }

  lines.push('If you have any questions, please let us know.', '', 'Thanks,', 'Echo Barrier USA LLC')

  return {
    subject: `Echo Barrier invoice ${number}`,
    body: lines.join('\n'),
  }
}
