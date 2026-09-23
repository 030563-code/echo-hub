/**
 * How each organisation invoices: the one place the invoicing module asks
 * "which country, which currency, which tax engine, which Xero".
 *
 * Until 22 Sep 2026 the answer was hardcoded as the USA in nine separate
 * places (open-invoice.ts, the accepted queue, the per-deal page, the tax
 * step, the address schemas, the Xero client, the seller block, the PDF and
 * the editor), each one a refusal of the form `org !== 'EB-USA'`. France is
 * the second organisation to invoice through the Hub, and it differs from the
 * USA in exactly the ways listed on a profile below. Anything not on a profile
 * is the same for every organisation and stays where it was.
 *
 * Pure data, safe on both client and server: the editor reads it to decide
 * which fields to show, the actions read it to decide what to refuse. The
 * environment variable NAMES are here; their values never are.
 *
 * 🔴 An organisation with no profile cannot invoice through the Hub, and the
 * module says so rather than defaulting to the USA. Canada, s.r.o., the UK and
 * Australia have none yet, on purpose.
 */

import type { OrgCode } from '@/lib/organisations'
import { US_DEPOTS, FR_DEPOTS, type InvoiceDepot } from './constants'

/**
 * Who prices the tax.
 *
 *   taxjar      The USA. TaxJar computes destination sales tax per line and the
 *               Hub posts the AMOUNT to Xero against a 0% rate, so Xero computes
 *               nothing. Then the sale is filed with TaxJar under the invoice
 *               number.
 *   xero_draft  France. The Hub posts a DRAFT invoice to Xero carrying an
 *               explicit TaxType per line, Xero computes the TVA, and the Hub
 *               reads the figures back before anyone approves anything. Nothing
 *               is filed anywhere: the authorised Xero invoice IS the record.
 *               Dean, 22 Sep 2026: "it creates a draft invoice in Xero then
 *               returns tax lines".
 */
export type TaxEngine = 'taxjar' | 'xero_draft'

export type InvoiceCountry = 'US' | 'FR'

export interface InvoicingProfile {
  org: OrgCode
  currency: 'USD' | 'EUR'
  /** What customer_invoices.delivery_country stores for this organisation.
   *  One country per organisation today; the CHECK constraint lists them. */
  country: InvoiceCountry
  /** The depots whose deals this organisation invoices. */
  depots: readonly InvoiceDepot[]
  taxEngine: TaxEngine
  /** The account_registry column holding this organisation's Xero account
   *  numbers for its customers. Different Xero organisation, different codes. */
  accountCodeColumn: 'usa_xero_account_code' | 'france_xero_account_code'
  /** The environment variables naming the n8n webhook for this organisation's
   *  Xero. Names only. A different Xero tenant needs a different workflow,
   *  because the USA one carries its tenant id in ten separate nodes. */
  webhookUrlEnv: string
  webhookSecretEnv: string
  /**
   * The Xero TaxType posted on every line.
   *
   * USA: 'OUTPUT', "Tax on Sales", EffectiveRate 0. Xero computes nothing and
   * the per-line TaxAmount from TaxJar stands. Read live 2026-09-04.
   *
   * France: 'TAX001', "Sales Tax FR", EffectiveRate 20, CanApplyToRevenue.
   * Read live from Echo Barrier SAS on 2026-09-22 (execution 110272). 🔴 It
   * MUST be sent explicitly: 20 of the organisation's 21 revenue accounts
   * default to OUTPUT at 0%, so a draft posted with no TaxType comes back
   * zero-rated, returns 200, and would carry straight through to an authorised
   * invoice understated by 20%. This is domestic TVA only. Intra-EU exempt
   * supply, export and reverse charge have NO code in that organisation yet;
   * that decision belongs to the accountant and is an open gap.
   */
  xeroTaxType: string
  /** The tax type's name and rate as Xero shows them, for the Tax Setup page.
   *  Read live alongside xeroTaxType. The rate is Xero's to apply, never the
   *  Hub's. */
  xeroTaxTypeName: string
  /** Whether the Hub sends its own per-line tax amount (TaxJar) or leaves the
   *  key OFF the line entirely so Xero computes it. 🔴 A supplied TaxAmount
   *  silently overrides Xero's own figure, proven live on 2026-09-01 (Xero
   *  stored 1125 over its own 875). So for Xero-computed tax the key must be
   *  ABSENT, not zero. */
  sendsTaxAmount: boolean
  /** The prefix on the internal holding reference a draft carries before it is
   *  numbered. USI2026-00014 for the USA. Internal, gaps harmless, but it is
   *  what a French draft would be called in Xero for a while, so it should not
   *  say US. */
  holdingPrefix: string
  /** The customer-facing series the organisation's invoices are numbered in,
   *  EBUS26-0001 for the USA. Decided in SQL by raise_customer_invoice on
   *  organisation_code; this is the same word, so a screen can say which
   *  number a step allocates without knowing the USA's. */
  invoiceSeries: string
  /** BCP 47 locale for money and dates on the customer's document. */
  locale: string
  /** What the document calls the tax line. */
  taxLabel: string
}

const PROFILES: Partial<Record<OrgCode, InvoicingProfile>> = {
  'EB-USA': {
    org: 'EB-USA',
    currency: 'USD',
    country: 'US',
    depots: US_DEPOTS,
    taxEngine: 'taxjar',
    accountCodeColumn: 'usa_xero_account_code',
    webhookUrlEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL',
    webhookSecretEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET',
    xeroTaxType: 'OUTPUT',
    xeroTaxTypeName: 'Tax on Sales, 0%',
    sendsTaxAmount: true,
    holdingPrefix: 'USI',
    invoiceSeries: 'EBUS',
    locale: 'en-US',
    taxLabel: 'Sales tax',
  },
  'EB-FRANCE': {
    org: 'EB-FRANCE',
    currency: 'EUR',
    country: 'FR',
    depots: FR_DEPOTS,
    taxEngine: 'xero_draft',
    accountCodeColumn: 'france_xero_account_code',
    webhookUrlEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL_FR',
    webhookSecretEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET_FR',
    xeroTaxType: 'TAX001',
    xeroTaxTypeName: 'Sales Tax FR, 20%',
    sendsTaxAmount: false,
    holdingPrefix: 'FRI',
    invoiceSeries: 'EBFR',
    locale: 'fr-FR',
    taxLabel: 'TVA',
  },
}

/** The profile, or null for an organisation that does not invoice through the
 *  Hub. Never a default. */
export function invoicingProfile(org: string | null | undefined): InvoicingProfile | null {
  const code = String(org ?? '').trim().toUpperCase()
  return (PROFILES as Record<string, InvoicingProfile | undefined>)[code] ?? null
}

/** The profile of the organisation that invoices deals from this depot. */
export function invoicingProfileForDepot(depot: string | null | undefined): InvoicingProfile | null {
  const code = String(depot ?? '').trim().toUpperCase()
  if (code === '') return null
  return Object.values(PROFILES).find((p) => p && (p.depots as readonly string[]).includes(code)) ?? null
}

/** The organisations whose invoicing is live in the Hub, in registry order. */
export const INVOICING_LIVE_ORGS: readonly OrgCode[] = Object.keys(PROFILES) as OrgCode[]

/** The label a stage tab or chip shows, where it depends on the tax engine.
 *  "TaxJar order transaction created" is the right name for Dave's step and a
 *  puzzle for Claire's, whose step files nothing. */
export function filedStageLabel(engine: TaxEngine): string {
  return engine === 'taxjar' ? 'TaxJar order transaction created' : 'Invoice numbered'
}

/** The chip on a numbered invoice. "Filed with TaxJar" is true of Dave's and
 *  false of Claire's, whose numbering step files nothing anywhere. */
export function filedChipLabel(engine: TaxEngine): string {
  return engine === 'taxjar' ? 'Filed with TaxJar' : 'Numbered'
}
