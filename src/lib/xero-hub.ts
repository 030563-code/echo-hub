import 'server-only'

/**
 * The Hub's only route to Xero, via n8n.
 *
 * Xero credentials live in n8n and never in this repo, which is public. Every
 * call here posts to the same gated invoicing webhook and is distinguished by
 * `action`; a payload with no action is the invoice-authorize path and is
 * untouched by anything in this file.
 */

import type { XeroPaymentTerms } from '@/lib/customer-invoice/payment-terms'

const TIMEOUT_MS = 20_000

export interface XeroContactAddress {
  line1: string | null
  line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
}

export interface XeroContact {
  contact_id: string
  name: string | null
  account_number: string | null
  email: string | null
  address: XeroContactAddress | null
  payment_terms: XeroPaymentTerms | null
  currency: string | null
}

export type XeroCall<T> = { ok: true; data: T } | { ok: false; error: string }

async function callXero<T>(body: Record<string, unknown>): Promise<XeroCall<T>> {
  const url = process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_URL
  if (!url) return { ok: false, error: 'The invoice webhook is not configured on the server.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (res.status === 401) return { ok: false, error: 'Xero lookup rejected: the Hub webhook secret does not match n8n.' }
    if (!res.ok) return { ok: false, error: `Xero lookup failed (HTTP ${res.status}).` }

    // A workflow branch that throws answers 200 with an EMPTY body rather than
    // an error document, so an empty response has to be read as failure. Fail
    // closed: never treat "no answer" as "nothing found".
    const text = await res.text()
    if (!text.trim()) return { ok: false, error: 'Xero returned an empty response. Nothing was changed.' }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: 'Xero returned a response that could not be read.' }
    }
    // THE CONTRACT: every action branch in the n8n workflow must answer with
    // `ok: true` alongside its payload. Anything else is a rejection, including
    // a perfectly good result that simply forgot the envelope. That is not
    // theoretical: "Respond Tracking Categories" returned a full, correct
    // { categories: [...] } with no `ok`, and the picker showed an error while
    // the n8n run showed a success. If a lookup errors here but the execution
    // log looks fine, check the responding node for this field first.
    const payload = json as { ok?: boolean; error?: string }
    if (payload?.ok !== true) return { ok: false, error: payload?.error || 'Xero rejected the request.' }
    return { ok: true, data: json as T }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { ok: false, error: aborted ? 'Xero did not respond in time.' : 'Xero could not be reached.' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Xero item code to sales account code, for every item in the org.
 *
 * The account is a property of the ITEM and varies per product (H9 07-4008,
 * H10 07-4014, H9X 07-4015, hooks and bungees 07-4080, freight 07-4150), so it
 * cannot be derived from a goods-versus-freight rule here. A value of null is
 * a real answer: some sold items carry no sales account in Xero at all.
 */
export async function xeroItemAccounts(): Promise<XeroCall<Record<string, string | null>>> {
  const res = await callXero<{ accounts: Record<string, string | null> }>({ action: 'lookup_items' })
  return res.ok ? { ok: true, data: res.data.accounts ?? {} } : res
}

/**
 * The organisation's tracking categories, straight from Xero.
 *
 * Read live rather than cached in our schema: a category or option added in
 * Xero must be pickable immediately, and unlike a bill-to there is nothing here
 * that an issued invoice needs frozen. What IS frozen is the rep's selection,
 * which stores the id and the name together on the line.
 */
export async function xeroTrackingCategories(): Promise<XeroCall<unknown[]>> {
  const res = await callXero<{ categories?: unknown[] }>({ action: 'lookup_tracking_categories' })
  return res.ok ? { ok: true, data: res.data.categories ?? [] } : res
}

/** The Xero contact for an account number, or null when Xero has none. */
export async function xeroFindContact(accountNumber: string): Promise<XeroCall<XeroContact | null>> {
  const account = accountNumber.trim()
  if (!account) return { ok: false, error: 'No Xero account number to look up.' }
  const res = await callXero<{ found: boolean; contact?: XeroContact }>({
    action: 'lookup_contact',
    account_number: account,
  })
  if (!res.ok) return res
  return { ok: true, data: res.data.found && res.data.contact ? res.data.contact : null }
}

export interface SaveXeroContactInput {
  /** Present = update that contact. Absent = create a new one. */
  contactId?: string | null
  accountNumber: string
  name: string
  email?: string | null
  address?: Partial<XeroContactAddress> | null
  paymentTerms?: XeroPaymentTerms | null
}

/** Create or update the Xero contact. Only the billing (POBOX) address is
 *  written; the delivery address stays on the invoice, per shipment. */
export async function xeroSaveContact(input: SaveXeroContactInput): Promise<XeroCall<XeroContact>> {
  const res = await callXero<{ contact: XeroContact }>({
    action: 'save_contact',
    contact_id: input.contactId ?? null,
    account_number: input.accountNumber,
    name: input.name,
    email: input.email ?? null,
    address: input.address ?? null,
    payment_terms: input.paymentTerms ?? null,
  })
  if (!res.ok) return res
  if (!res.data.contact) return { ok: false, error: 'Xero saved nothing back.' }
  return { ok: true, data: res.data.contact }
}
