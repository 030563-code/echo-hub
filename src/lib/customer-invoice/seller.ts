/**
 * Who the invoice is FROM, and how to pay it. Per organisation.
 *
 * Two halves with different homes, for one reason: this repository is public.
 *
 * The letterhead is not a secret. It is printed on every quote and invoice the
 * business has ever sent, so it lives here as data. Dean confirmed on
 * 2026-09-03 that the USA invoicing address is the Chicago office, not the
 * Jessup MD address the `entities` table carries for EB-USA: that one is
 * byte-identical to the US-BAL depot's dispatch address, so it is the warehouse
 * rather than a registered office.
 *
 * The remittance block IS sensitive. An account number on a customer's invoice
 * is seen by one accounts-payable department; the same number in a public git
 * history is the standard raw material for invoice-redirection fraud. So every
 * remittance field comes from the environment and NOTHING is defaulted here.
 * An unset field prints as a visible placeholder rather than silently vanishing,
 * because an invoice that quietly omits how to pay it is worse than one that
 * says the detail is missing.
 */

import type { OrgCode } from '@/lib/organisations'

/** The seller block, exactly as the Quotes Hub PDF printed it. */
export const SELLER_ADDRESS_LINES: readonly string[] = [
  'Echo Barrier USA LLC',
  '33 North Dearborn',
  'Suite 1000',
  'Chicago',
  'IL 60602',
  'USA',
]

export const SELLER_LEGAL_NAME = 'Echo Barrier USA LLC'

/**
 * The North American toll-free carried by the US and Canadian quote templates.
 * It is a group number that happens to have been printed on US quotes rather
 * than an AR desk, which is why the email below sits under it: a customer with
 * a billing question needs somewhere that reads the invoice, not switchboard.
 */
export const SELLER_PHONE = '+1 (800) 728 9098'

/** Where a customer replies about an invoice. Dean, 2026-09-03. */
export const SELLER_EMAIL = 'accounts@echobarrier.com'

/** The letterhead and statutory identity of the company issuing the invoice. */
export interface SellerBlock {
  legalName: string
  /** Letterhead lines, legal name first. */
  addressLines: readonly string[]
  phone: string
  email: string
  /**
   * Statutory mentions a document must carry, printed under the letterhead.
   * Empty for the USA. For France: SIREN, RCS and TVA, every one read from at
   * least two independent sources on 22 Sep 2026 (INSEE, BODACC, Xero, her own
   * invoices). The share capital ("SAS au capital de 5 000 EUR") is a required
   * mention too and is DELIBERATELY ABSENT: it is single-sourced from the 2023
   * incorporation notice and has not been confirmed against a Kbis. A wrong
   * capital on an invoice is a worse fault than a missing one. Open gap.
   */
  legalMentions: readonly string[]
}

const SELLERS: Partial<Record<OrgCode, SellerBlock>> = {
  'EB-USA': {
    legalName: SELLER_LEGAL_NAME,
    addressLines: SELLER_ADDRESS_LINES,
    phone: SELLER_PHONE,
    email: SELLER_EMAIL,
    legalMentions: [],
  },
  'EB-FRANCE': {
    legalName: 'Echo Barrier SAS',
    // Siège social, per INSEE (est_siege=true), BODACC on three announcements,
    // and the sender header of every one of Claire's invoices. Not the Société
    // Générale branch, which sits at 29 boulevard Haussmann. Spelling traps:
    // "Madeleine" (Xero holds a typo), no "8e Arrondissement" suffix, lowercase
    // "place".
    addressLines: ['Echo Barrier SAS', '25 place de la Madeleine', '75008 Paris', 'France'],
    // The landline on 22 of her 27 invoices, in international form. The bare
    // national "01 85 14 95 00" is unusable from outside France.
    phone: '+33 1 85 14 95 00',
    // Printed on all 27 of her invoices as the contact.
    email: 'claire.lavoisier@echobarrier.com',
    legalMentions: ['SIREN 978 450 930', 'RCS Paris 978 450 930', 'TVA FR09978450930'],
  },
}

/** The seller for an organisation. Throws for one that does not invoice
 *  through the Hub: a document with no issuer must never render. */
export function sellerFor(org: OrgCode): SellerBlock {
  const seller = SELLERS[org]
  if (!seller) throw new Error(`${org} has no seller block; it does not invoice through the Hub.`)
  return seller
}

export interface RemittanceDetails {
  /** The name the account is held in. Must match the bank's own record exactly,
   *  which is why it comes from the bank letter rather than from the legal
   *  name: a payee name that differs from the account name is a reason for a
   *  bank to bounce a transfer. For France the registered denomination IS
   *  "ECHO BARRIER", so the two happen to agree. */
  accountName: string
  bankName: string | null
  /** The bank's own address, as lines. Pipe-separated in the environment. */
  bankAddress: string[]
  /** US: ABA routing number. Null for a European account. */
  routingNumber: string | null
  /** US: the account number. Null for a European account, which uses the IBAN. */
  accountNumber: string | null
  /** The seller's federal EIN. Absent until the Maryland Comptroller confirms
   *  it on the Combined Registration Application (see constants.ts). */
  ein: string | null
  /** EU: the IBAN, spaced as the bank prints it. */
  iban?: string | null
  /** EU: the BIC / SWIFT code. */
  bic?: string | null
  /** Which set of fields is the payment instruction. Defaults to 'us' so the
   *  existing USA rows and tests are unchanged. */
  scheme?: 'us' | 'eu'
}

function env(name: string): string | null {
  const value = String(process.env[name] ?? '').trim()
  return value === '' ? null : value
}

/**
 * Read the remittance block from the environment, for one organisation.
 *
 * Server-side only in practice, because that is where process.env is populated.
 * The result is passed down to the renderer rather than read by it, so the
 * renderer stays pure and testable.
 */
export function remittanceFromEnv(org: OrgCode = 'EB-USA'): RemittanceDetails {
  if (org === 'EB-FRANCE') {
    return {
      accountName: env('INVOICE_REMIT_FR_ACCOUNT_NAME') ?? 'ECHO BARRIER',
      bankName: env('INVOICE_REMIT_FR_BANK_NAME'),
      bankAddress: [],
      routingNumber: null,
      accountNumber: null,
      ein: null,
      iban: env('INVOICE_REMIT_FR_IBAN'),
      bic: env('INVOICE_REMIT_FR_BIC'),
      scheme: 'eu',
    }
  }
  return {
    accountName: env('INVOICE_REMIT_ACCOUNT_NAME') ?? SELLER_LEGAL_NAME,
    bankName: env('INVOICE_REMIT_BANK_NAME'),
    // Pipe-separated so a multi-line branch address survives a single env var.
    bankAddress: (env('INVOICE_REMIT_BANK_ADDRESS') ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
    routingNumber: env('INVOICE_REMIT_ROUTING_NUMBER'),
    accountNumber: env('INVOICE_REMIT_ACCOUNT_NUMBER'),
    ein: env('INVOICE_SELLER_EIN'),
    scheme: 'us',
  }
}

/** How an unset remittance field prints. Matches the mockup's own notation, so
 *  a reviewer can see at a glance which values are still outstanding. */
export function remittanceValue(value: string | null | undefined, placeholder: string): string {
  return value ?? `<${placeholder}>`
}

/** True when anything a customer needs in order to pay is still unset, so the
 *  caller can refuse to send a document that cannot be paid from. */
export function remittanceIsIncomplete(r: RemittanceDetails): boolean {
  if (r.scheme === 'eu') return r.bankName === null || !r.iban || !r.bic
  return r.bankName === null || r.routingNumber === null || r.accountNumber === null
}
