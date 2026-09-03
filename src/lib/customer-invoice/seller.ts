/**
 * Who the invoice is FROM, and how to pay it.
 *
 * Two halves with different homes, for one reason: this repository is public.
 *
 * The letterhead is not a secret. It is printed on every quote the Hub has ever
 * sent, so it lives here as data. Dean confirmed on 2026-09-03 that the
 * invoicing address is the Chicago office, not the Jessup MD address the
 * `entities` table carries for EB-USA: that one is byte-identical to the US-BAL
 * depot's dispatch address, so it is the warehouse rather than a registered
 * office.
 *
 * The remittance block IS sensitive. An account number on a customer's invoice
 * is seen by one accounts-payable department; the same number in a public git
 * history is the standard raw material for invoice-redirection fraud. So every
 * remittance field comes from the environment and NOTHING is defaulted here.
 * An unset field prints as a visible placeholder rather than silently vanishing,
 * because an invoice that quietly omits how to pay it is worse than one that
 * says the detail is missing.
 */

/** The seller block, exactly as the Quotes Hub PDF printed it. */
export const SELLER_ADDRESS_LINES: readonly string[] = [
  'Echo Barrier USA LLC',
  '33 North Dearborn',
  'Suite 1000',
  'Chicago',
  'IL 60602',
  'USA',
]

export const SELLER_LEGAL_NAME = 'Echo Barrier USA, LLC'

/**
 * The North American toll-free carried by the US and Canadian quote templates.
 * Confirm before treating it as an accounts-receivable line: it is a group
 * number that happens to have been printed on US quotes, not an AR desk.
 */
export const SELLER_PHONE = '+1 (800) 728 9098'

export interface RemittanceDetails {
  payee: string
  bankName: string | null
  achRouting: string | null
  accountNumber: string | null
  wireRouting: string | null
  swift: string | null
  /** The seller's federal EIN. Absent until the Maryland Comptroller confirms
   *  it on the Combined Registration Application (see constants.ts). */
  ein: string | null
}

function env(name: string): string | null {
  const value = String(process.env[name] ?? '').trim()
  return value === '' ? null : value
}

/**
 * Read the remittance block from the environment.
 *
 * Server-side only in practice, because that is where process.env is populated.
 * The result is passed down to the renderer rather than read by it, so the
 * renderer stays pure and testable.
 */
export function remittanceFromEnv(): RemittanceDetails {
  return {
    payee: SELLER_LEGAL_NAME,
    bankName: env('INVOICE_REMIT_BANK_NAME'),
    achRouting: env('INVOICE_REMIT_ACH_ROUTING'),
    accountNumber: env('INVOICE_REMIT_ACCOUNT_NUMBER'),
    wireRouting: env('INVOICE_REMIT_WIRE_ROUTING'),
    swift: env('INVOICE_REMIT_SWIFT'),
    ein: env('INVOICE_SELLER_EIN'),
  }
}

/** How an unset remittance field prints. Matches the mockup's own notation, so
 *  a reviewer can see at a glance which values are still outstanding. */
export function remittanceValue(value: string | null, placeholder: string): string {
  return value ?? `<${placeholder}>`
}

/** True when anything in the remittance block is still unset, so the caller can
 *  warn before a document with placeholders goes to a customer. */
export function remittanceIsIncomplete(r: RemittanceDetails): boolean {
  return r.bankName === null || r.achRouting === null || r.accountNumber === null
}
