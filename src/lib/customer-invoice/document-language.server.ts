import 'server-only'

import { hubspotFetch } from '@/lib/hubspot-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { logInvoiceEvent } from '@/app/actions/invoicing/shared'
import type { InvoicingProfile } from './invoicing-profile'
import {
  DEFAULT_DOCUMENT_LANGUAGE,
  documentLanguagesFor,
  languageFromHubSpot,
  pickAcceptedQuote,
  type DealQuote,
  type DocumentLanguage,
} from './document-language'

/**
 * The language a new invoice starts in, from the deal's quote in HubSpot.
 *
 * Read live from HubSpot when the draft is opened, because that is the only
 * place it exists. hs_language lives on the HubSpot quote, inherited from its
 * template, and nothing copies it into Supabase. deal_quotes records the
 * template of the quotes the Hub itself published, but Claire makes her quotes
 * in HubSpot (none of hers was in deal_quotes on 24 Sep 2026), so it would miss
 * every one of them. Opening a draft already reads the line descriptions from
 * HubSpot for the same reason.
 *
 * Never throws and never blocks. A draft has to open when HubSpot is down, so a
 * failed read starts the invoice in English and the event log says why; the
 * reviewer sees the language in the editor and can change it.
 */

const HS = 'https://api.hubapi.com'

/** HubSpot's batch read caps at 100 inputs per call. */
const BATCH = 100

type Fetcher = typeof hubspotFetch

export interface QuoteLanguageRead {
  language: DocumentLanguage
  /** Why this language: the deal's quote said so, the deal has no quote, or
   *  HubSpot could not be read. */
  source: 'quote' | 'no_quote' | 'unreadable'
  quoteId: string | null
  /** The quote's own value, kept for the event log. */
  hsLanguage: string | null
  error?: string
}

function english(source: 'no_quote' | 'unreadable', error?: string): QuoteLanguageRead {
  return { language: DEFAULT_DOCUMENT_LANGUAGE, source, quoteId: null, hsLanguage: null, ...(error ? { error } : {}) }
}

/**
 * The language of the quote the customer accepted on this deal. Two reads: the
 * deal's quote associations, then the quotes themselves.
 */
export async function readDealQuoteLanguage(dealId: string, fetcher: Fetcher = hubspotFetch): Promise<QuoteLanguageRead> {
  if (!/^\d{1,20}$/.test(dealId)) return english('unreadable', 'not a HubSpot deal id')
  try {
    const assoc = await fetcher(`${HS}/crm/v4/objects/deals/${dealId}/associations/quotes?limit=500`)
    // Never log a body: HubSpot echoes the request back on some errors.
    if (!assoc.ok) return english('unreadable', `quote associations answered ${assoc.status}`)
    const assocData = (await assoc.json()) as { results?: { toObjectId?: string | number }[] }
    const ids = [
      ...new Set((assocData.results ?? []).map((r) => String(r.toObjectId ?? '')).filter((id) => /^\d+$/.test(id))),
    ]
    if (ids.length === 0) return english('no_quote')

    const quotes: DealQuote[] = []
    for (let i = 0; i < ids.length; i += BATCH) {
      const response = await fetcher(`${HS}/crm/v3/objects/quotes/batch/read`, {
        method: 'POST',
        body: JSON.stringify({
          properties: ['hs_language', 'hs_status', 'hs_createdate'],
          inputs: ids.slice(i, i + BATCH).map((id) => ({ id })),
        }),
      })
      if (!response.ok) return english('unreadable', `quote read answered ${response.status}`)
      const data = (await response.json()) as {
        results?: { id?: string; createdAt?: string; properties?: Record<string, string | null | undefined> }[]
      }
      for (const row of data.results ?? []) {
        const id = String(row.id ?? '').trim()
        if (id === '') continue
        quotes.push({
          id,
          status: row.properties?.hs_status ?? null,
          language: row.properties?.hs_language ?? null,
          createdAt: row.properties?.hs_createdate ?? row.createdAt ?? null,
        })
      }
    }

    const chosen = pickAcceptedQuote(quotes)
    if (!chosen) return english('no_quote')
    return {
      language: languageFromHubSpot(chosen.language),
      source: 'quote',
      quoteId: chosen.id,
      hsLanguage: chosen.language,
    }
  } catch (error) {
    return english('unreadable', error instanceof Error ? error.message : 'unknown error')
  }
}

/**
 * Give a draft that has just been opened its language, and record why.
 *
 * Only for an organisation whose invoices come in more than one language. Any
 * other stays in English, the column's default, without a HubSpot read or a
 * write: a USA invoice is English and shows no choice.
 *
 * `carriedOver` is the language of the draft a rebuild replaced. It wins over
 * the quote for the reason the collection flag does: it is what the reviewer
 * settled on, which is later information than the quote.
 *
 * Returns the language the draft ended up in.
 */
export async function setOpeningDocumentLanguage(input: {
  invoiceId: string
  dealId: string
  profile: InvoicingProfile
  carriedOver?: DocumentLanguage
  actorUid: string
  fetcher?: Fetcher
}): Promise<DocumentLanguage> {
  const offered = documentLanguagesFor(input.profile)
  if (offered.length < 2) return DEFAULT_DOCUMENT_LANGUAGE

  const carried = input.carriedOver && offered.includes(input.carriedOver) ? input.carriedOver : null
  const read = carried ? null : await readDealQuoteLanguage(input.dealId, input.fetcher)
  let language: DocumentLanguage = carried ?? read?.language ?? DEFAULT_DOCUMENT_LANGUAGE
  if (!offered.includes(language)) language = DEFAULT_DOCUMENT_LANGUAGE

  let writeError: string | null = null
  if (language !== DEFAULT_DOCUMENT_LANGUAGE) {
    try {
      const { error } = await createAdminClient()
        .from('customer_invoices')
        .update({ document_language: language })
        .eq('id', input.invoiceId)
        .eq('status', 'draft')
      if (error) writeError = error.message ?? 'update failed'
    } catch (error) {
      writeError = error instanceof Error ? error.message : 'update failed'
    }
    if (writeError) {
      // The draft stays in English and opens anyway; the reviewer can change
      // it in the editor. Logged so a pattern of these is visible.
      console.error('setOpeningDocumentLanguage: the language could not be stored', { invoiceId: input.invoiceId, writeError })
      language = DEFAULT_DOCUMENT_LANGUAGE
    }
  }

  await logInvoiceEvent(input.invoiceId, 'language_defaulted', input.actorUid, {
    language,
    source: carried ? 'rebuilt' : (read?.source ?? 'no_quote'),
    quote_id: read?.quoteId ?? null,
    hs_language: read?.hsLanguage ?? null,
    ...(read?.error ? { read_error: read.error } : {}),
    ...(writeError ? { write_error: writeError } : {}),
  })
  return language
}
