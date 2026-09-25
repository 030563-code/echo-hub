/**
 * Which language a customer invoice is written in.
 *
 * Claire invoices French customers mostly and Spanish ones too: her quotes by
 * HubSpot language run fr 404, es 160, and a few dozen each in German,
 * Portuguese and English. The PDF printed English labels whoever it was for.
 * Its labels and its dates now print in English, French or Spanish.
 *
 * The language belongs to the INVOICE. It is chosen when the draft is opened,
 * from the deal's quote in HubSpot, can be changed in the editor while the
 * invoice is still editable, and is stored on the row
 * (customer_invoices.document_language). It is never worked out at render time:
 * the PDF is rendered again at Email and again for the Xero attachment, and
 * each time it is compared byte for byte with the hash taken at Generate. A
 * language that could change between two renders would make an issued invoice
 * unsendable, and a reprint read differently from the customer's copy.
 *
 * Only the labels and the way dates are written change. Amounts keep the
 * organisation's own number format, and the tax wording, the legal names and
 * every stored value print exactly as they are, in every language.
 *
 * Pure and safe on the client: the editor reads the names and the choices from
 * here.
 */

export const DOCUMENT_LANGUAGES = ['en', 'fr', 'es'] as const

export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number]

/** What every invoice printed before there was a choice, and what an
 *  organisation without one always prints. */
export const DEFAULT_DOCUMENT_LANGUAGE: DocumentLanguage = 'en'

/** What each language calls itself, for the editor's choice. */
export const DOCUMENT_LANGUAGE_NAMES: Record<DocumentLanguage, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
}

export function isDocumentLanguage(value: unknown): value is DocumentLanguage {
  return typeof value === 'string' && (DOCUMENT_LANGUAGES as readonly string[]).includes(value)
}

/** The stored column, read back. Anything unrecognised is English. */
export function documentLanguage(value: unknown): DocumentLanguage {
  return isDocumentLanguage(value) ? value : DEFAULT_DOCUMENT_LANGUAGE
}

/**
 * The languages an organisation's invoices can be written in, in the order the
 * editor offers them. An organisation that lists none writes English only and
 * the editor shows no choice, which is the USA.
 */
export function documentLanguagesFor(
  profile: { documentLanguages?: readonly DocumentLanguage[] } | null | undefined,
): readonly DocumentLanguage[] {
  return profile?.documentLanguages ?? [DEFAULT_DOCUMENT_LANGUAGE]
}

/**
 * The language a stored invoice prints in: its own, when its organisation
 * writes in that language, and English otherwise. So a USA invoice prints in
 * English whatever the column says.
 */
export function invoiceLanguage(
  profile: { documentLanguages?: readonly DocumentLanguage[] } | null | undefined,
  stored: unknown,
): DocumentLanguage {
  const language = documentLanguage(stored)
  return documentLanguagesFor(profile).includes(language) ? language : DEFAULT_DOCUMENT_LANGUAGE
}

/**
 * A HubSpot quote's hs_language, as the language of the invoice that follows it.
 *
 * fr is French and es is Spanish, with or without a region ('fr-ca', 'es-mx'),
 * because the words on an invoice are the same in either. Everything else is
 * English: German and Portuguese quotes exist, but an invoice is written in
 * one of these three only.
 */
export function languageFromHubSpot(hsLanguage: unknown): DocumentLanguage {
  const primary = String(hsLanguage ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (primary === 'fr') return 'fr'
  if (primary === 'es') return 'es'
  return DEFAULT_DOCUMENT_LANGUAGE
}

/** A quote on the deal, as much of it as choosing one needs. */
export interface DealQuote {
  id: string
  /** hs_status. */
  status: string | null
  /** hs_language, inherited from the quote template. */
  language: string | null
  /** hs_createdate, an ISO timestamp. */
  createdAt: string | null
}

/**
 * The statuses under which HubSpot has published a quote at its public link,
 * so a customer could have read it and said yes. HubSpot's quotes guide:
 * APPROVAL_NOT_NEEDED publishes without an approval and APPROVED publishes
 * after one. DRAFT, PENDING_APPROVAL and REJECTED never reach a customer.
 */
const PUBLISHED_QUOTE_STATUSES = new Set(['APPROVAL_NOT_NEEDED', 'APPROVED'])

function createdMs(quote: DealQuote): number {
  const ms = Date.parse(String(quote.createdAt ?? ''))
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/** Newest first, and the larger id first on a tie, so the choice never depends
 *  on the order HubSpot happened to list the quotes in. */
function newestFirst(a: DealQuote, b: DealQuote): number {
  const byDate = createdMs(b) - createdMs(a)
  if (byDate !== 0 && !Number.isNaN(byDate)) return byDate
  if (a.id.length !== b.id.length) return b.id.length - a.id.length
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * The quote the customer accepted, as nearly as HubSpot can say.
 *
 * HubSpot records no acceptance on a quote. Acceptance is the DEAL moving to
 * Quotation Accepted, and HubSpot's quote statuses only describe publishing.
 * So this takes the newest published quote, the last one the customer could
 * have been reading when they said yes. A deal whose quotes were never
 * published falls back to its newest quote of any status, which still carries
 * the language the rep chose for that customer. No quotes at all is null, and
 * the invoice starts in English.
 */
export function pickAcceptedQuote(quotes: readonly DealQuote[]): DealQuote | null {
  if (quotes.length === 0) return null
  const published = quotes.filter((q) => PUBLISHED_QUOTE_STATUSES.has(String(q.status ?? '').trim().toUpperCase()))
  const pool = published.length > 0 ? published : quotes
  return [...pool].sort(newestFirst)[0] ?? null
}

/** How each language writes a date when the organisation's own locale is in
 *  another language. */
const HOME_DATE_LOCALE: Record<DocumentLanguage, string> = {
  en: 'en-GB',
  fr: 'fr-FR',
  es: 'es-ES',
}

/**
 * The locale a date is written in, on a document in `language` from an
 * organisation whose own locale is `orgLocale`.
 *
 * An organisation writing in its own language writes dates its own way, so the
 * USA's English stays American, "September 3, 2026", exactly as it has always
 * printed. Any other language is written the way its home country writes it:
 * "24 septembre 2026", "24 de septiembre de 2026", and English from France in
 * British order, "24 September 2026", which is how Claire's English quotes
 * (en-gb) read too.
 */
export function dateLocaleFor(language: DocumentLanguage, orgLocale: string): string {
  const orgLanguage = orgLocale.trim().toLowerCase().split(/[-_]/)[0]
  return orgLanguage === language ? orgLocale : HOME_DATE_LOCALE[language]
}

/**
 * A stored date as the document prints it, or null when there is none, which
 * the document shows as an empty cell.
 *
 * Built and formatted in UTC: these are date-only values, and local formatting
 * would print the previous day west of Greenwich. A value that is not a date
 * prints as itself rather than vanishing.
 */
export function formatDocumentDate(
  iso: string | null | undefined,
  language: DocumentLanguage,
  orgLocale: string,
): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return iso
  const day = Number(m[3])
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, day))
  const text = d
    .toLocaleDateString(dateLocaleFor(language, orgLocale), {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })
    // Helvetica in jsPDF cannot draw a no-break space and prints a wrong
    // character instead, the same trap the money formatter steps around.
    .replace(/[\u202F\u00A0]/g, ' ')
  // French writes the first of the month as an ordinal: 1er octobre 2026.
  return language === 'fr' && day === 1 ? text.replace(/^1(?=\s)/, '1er') : text
}
