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
 * module says so rather than defaulting to the USA. s.r.o., Group, the UK and
 * Australia have none yet, on purpose.
 *
 * Canada has one since 24 Sep 2026 with its Xero leg marked not connected: its
 * invoices open and edit here, and every step that would talk to Xero refuses
 * with the sentence on the profile. See xeroNotConnected.
 */

import { orgForDepot, type OrgCode } from '@/lib/organisations'
import { invoiceDepotsForOrg, type InvoiceDepot } from './constants'

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
 *               returns tax lines". Canada too, once connected: Dean, 17 Sep
 *               2026, "Send Invoice to Xero (Draft tax calculation)".
 */
export type TaxEngine = 'taxjar' | 'xero_draft'

export type InvoiceCountry = 'US' | 'FR' | 'CA'

export interface InvoicingProfile {
  org: OrgCode
  currency: 'USD' | 'EUR' | 'CAD'
  /** What customer_invoices.delivery_country stores for this organisation.
   *  One country per organisation today; the CHECK constraint lists them. */
  country: InvoiceCountry
  /** The depots whose deals this organisation invoices, read from the
   *  organisation registry so the two cannot disagree. */
  depots: readonly InvoiceDepot[]
  taxEngine: TaxEngine
  /**
   * Null when this organisation's Xero leg is connected to the Hub. Otherwise
   * the sentence its tax step answers with, and the reason every call to its
   * Xero is refused before anything leaves the Hub: lookups, the contact card,
   * the draft, the numbering and the authorise.
   *
   * Canada, 24 Sep 2026: its invoices open and edit in the Hub and stop at the
   * tax step, because the Xero draft that prices Canadian tax, and the n8n
   * workflow behind it, do not exist yet. Keyed in code rather than on an unset
   * environment variable, so a webhook URL set early (or set to the USA's) can
   * never send a Canadian invoice anywhere.
   */
  xeroNotConnected: string | null
  /** The account_registry column holding this organisation's Xero account
   *  numbers for its customers. Different Xero organisation, different codes. */
  accountCodeColumn: 'usa_xero_account_code' | 'france_xero_account_code' | 'canada_xero_account_code'
  /**
   * Whether deals_registry.currency is trusted enough to refuse a deal on.
   *
   * The USA SALES sync writes the deal's real currency, and it carries both USA
   * and Canada: every CA-HAM deal with lines is CAD (20 of 20, 24 Sep 2026), so
   * a USD deal on a Canadian depot, or a CAD one on a US depot, is a mistake
   * worth stopping. The EURO sync never wrote the column, so all 63 French
   * deals carry the default 'USD' and France cannot be held to it.
   */
  checksRegistryCurrency: boolean
  /** What the delivery address is for, as the acceptance dialog and the
   *  invoice editor say it under the address fields. */
  deliveryAddressUse: string
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
   *
   * Canada: null. Whether a Canadian line needs one is exactly what the first
   * Canadian draft is meant to show (the plan posts it with none and reads back
   * what Xero applies), and Canadian tax types are per-organisation codes that
   * are never guessed. Nothing is posted while the Xero leg is not connected.
   */
  xeroTaxType: string | null
  /** The tax type's name and rate as Xero shows them, for the Tax Setup page.
   *  Read live alongside xeroTaxType. The rate is Xero's to apply, never the
   *  Hub's. Null with it. */
  xeroTaxTypeName: string | null
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
    depots: invoiceDepotsForOrg('EB-USA'),
    taxEngine: 'taxjar',
    xeroNotConnected: null,
    accountCodeColumn: 'usa_xero_account_code',
    checksRegistryCurrency: true,
    deliveryAddressUse: 'Used to calculate US sales tax: the ship-to address, not the billing address.',
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
  'EB-CANADA': {
    org: 'EB-CANADA',
    currency: 'CAD',
    country: 'CA',
    depots: invoiceDepotsForOrg('EB-CANADA'),
    // Dean, 17 Sep 2026: "canada will have no send to taxjar step. Instead
    // Xero will be used instead for the tax calculations", on a draft, the way
    // France already works. Not connected yet, so every step that would reach
    // Xero stops at this sentence.
    taxEngine: 'xero_draft',
    xeroNotConnected: 'Canadian tax is worked out by Xero. That step is not connected to the Hub yet.',
    // Codes in two shapes, 3 older XXXCA01 and 12 current XXXCAN001 (24 Sep
    // 2026). Read as stored: nothing here says which shape the Canadian Xero
    // contact carries, and rewriting one into the other could point an invoice
    // at a contact Xero does not have.
    accountCodeColumn: 'canada_xero_account_code',
    checksRegistryCurrency: true,
    deliveryAddressUse:
      'Printed on the invoice, and its province decides the Canadian sales tax: the ship-to address, not the billing address.',
    // Never read while xeroNotConnected is set. They name the Canadian n8n
    // workflow the day it exists; Echo Barrier Canada, Inc is its own Xero
    // organisation and cannot share the USA's.
    webhookUrlEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL_CA',
    webhookSecretEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET_CA',
    xeroTaxType: null,
    xeroTaxTypeName: null,
    // Xero works the tax out, so our own amount must never travel with a line:
    // a supplied TaxAmount silently overrides Xero's figure.
    sendsTaxAmount: false,
    holdingPrefix: 'CAI',
    invoiceSeries: 'EBCA',
    locale: 'en-CA',
    taxLabel: 'Sales tax',
  },
  'EB-FRANCE': {
    org: 'EB-FRANCE',
    currency: 'EUR',
    country: 'FR',
    depots: invoiceDepotsForOrg('EB-FRANCE'),
    taxEngine: 'xero_draft',
    xeroNotConnected: null,
    accountCodeColumn: 'france_xero_account_code',
    checksRegistryCurrency: false,
    deliveryAddressUse: 'Printed on the invoice and decides the TVA case: the ship-to address, not the billing address.',
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

/**
 * The profile of the organisation that invoices deals from this depot.
 *
 * Which organisation owns a depot is the organisation registry's answer
 * (orgForDepot), asked here rather than kept as a second copy.
 */
export function invoicingProfileForDepot(depot: string | null | undefined): InvoicingProfile | null {
  const code = String(depot ?? '').trim().toUpperCase()
  if (code === '') return null
  const profile = invoicingProfile(orgForDepot(code))
  return profile && (profile.depots as readonly string[]).includes(code) ? profile : null
}

/** The organisations that invoice through the Hub, in registry order. Canada's
 *  Xero leg is not connected yet; see xeroNotConnected. */
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
