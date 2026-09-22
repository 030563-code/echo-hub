import 'server-only'

/**
 * The Hub's only route to Xero, via n8n.
 *
 * Xero credentials live in n8n and never in this repo, which is public. Every
 * call here posts to the invoicing webhook OF THE ORGANISATION and is
 * distinguished by `action`; a payload with no action is the invoice-authorize
 * path and is untouched by anything in this file.
 *
 * 🔴 ONE WEBHOOK PER ORGANISATION, never a default. Each Echo Barrier company
 * is a different Xero organisation, and the USA workflow carries its tenant id
 * as a literal header on ten separate nodes. A French call sent down the USA
 * webhook would look up contacts in, and post invoices into, Echo Barrier USA
 * LLC's ledger. So every call names its organisation and an organisation with
 * no configured webhook is refused with a sentence.
 */

import type { XeroPaymentTerms } from '@/lib/customer-invoice/payment-terms'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { orgLabel, type OrgCode } from '@/lib/organisations'

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

/** The webhook URL and secret for an organisation's Xero, or the reason there
 *  is none. Shared with the actions that post the authorize payload directly. */
export function xeroWebhookFor(org: OrgCode): { ok: true; url: string; secret: string | null } | { ok: false; error: string } {
  const profile = invoicingProfile(org)
  if (!profile) return { ok: false, error: `${orgLabel(org)} does not invoice through the Hub.` }
  const url = String(process.env[profile.webhookUrlEnv] ?? '').trim()
  if (!url) return { ok: false, error: `The ${orgLabel(org)} invoice webhook is not configured on the server (${profile.webhookUrlEnv}).` }
  const secret = String(process.env[profile.webhookSecretEnv] ?? '').trim() || null
  return { ok: true, url, secret }
}

async function callXero<T>(org: OrgCode, body: Record<string, unknown>): Promise<XeroCall<T>> {
  const hook = xeroWebhookFor(org)
  if (!hook.ok) return hook

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(hook.secret ? { 'x-hub-secret': hook.secret } : {}),
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
 * Xero item code to sales account code, for every item in the organisation.
 *
 * The account is a property of the ITEM and varies per product (H9 07-4008,
 * H10 07-4014, H9X 07-4015, hooks and bungees 07-4080, freight 07-4150), so it
 * cannot be derived from a goods-versus-freight rule here. A value of null is
 * a real answer: some sold items carry no sales account in Xero at all.
 */
export async function xeroItemAccounts(org: OrgCode): Promise<XeroCall<Record<string, string | null>>> {
  const res = await callXero<{ accounts: Record<string, string | null> }>(org, { action: 'lookup_items' })
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
export async function xeroTrackingCategories(org: OrgCode): Promise<XeroCall<unknown[]>> {
  const res = await callXero<{ categories?: unknown[] }>(org, { action: 'lookup_tracking_categories' })
  return res.ok ? { ok: true, data: res.data.categories ?? [] } : res
}

/** The Xero contact for an account number, or null when Xero has none. */
export async function xeroFindContact(org: OrgCode, accountNumber: string): Promise<XeroCall<XeroContact | null>> {
  const account = accountNumber.trim()
  if (!account) return { ok: false, error: 'No Xero account number to look up.' }
  const res = await callXero<{ found: boolean; contact?: XeroContact }>(org, {
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
export async function xeroSaveContact(org: OrgCode, input: SaveXeroContactInput): Promise<XeroCall<XeroContact>> {
  const res = await callXero<{ contact: XeroContact }>(org, {
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

/**
 * The line as the France draft leg posts it and reads it back.
 *
 * `line_key` travels to n8n and comes back on every returned line, so the tax
 * is mapped by identity rather than by position. Position would break the
 * moment Xero reordered, dropped or merged a line, and it would break silently.
 */
export interface XeroDraftLineInput {
  line_key: string
  item_code: string | null
  account_code: string | null
  description: string
  quantity: number
  unit_amount: number
  discount_rate: number
  tracking: unknown[]
}

export interface XeroDraftLineResult {
  line_key: string
  line_item_id: string | null
  line_amount: number
  tax_type: string | null
  tax_amount: number
}

export interface XeroDraftResult {
  xero_draft_invoice_id: string
  xero_invoice_number: string | null
  status: string
  sub_total: number
  total_tax: number
  total: number
  lines: XeroDraftLineResult[]
}

export interface XeroDraftInput {
  idempotency_key: string
  invoice_id: string
  /** The draft's InvoiceNumber in Xero. The internal holding reference until
   *  the real number is allocated; the authorise leg rewrites it. Never absent,
   *  because Xero mints one from its own sequence for anything posted without
   *  it and that number is burned for good. */
  invoice_number: string
  /** Present on a recalculation: n8n updates THIS draft in place rather than
   *  creating a second one, and refuses if it is no longer a DRAFT. */
  xero_draft_invoice_id: string | null
  hubspot_deal_id: string
  reference: string
  contact: { xero_account_number: string; hubspot_company_id: string | null; company_name: string | null }
  currency: string
  date: string
  due_date: string | null
  /** The Xero TaxType every line is posted with. Xero computes the tax from it;
   *  no tax amount is sent, by design. */
  tax_type: string
  lines: XeroDraftLineInput[]
  shipping_lines: XeroDraftLineInput[]
}

/**
 * Post (or update) a DRAFT invoice so Xero prices the tax, and read it back.
 *
 * 🔴 No `tax_amount` on any line, and the n8n node must leave the TaxAmount KEY
 * off the LineItem entirely: a supplied amount silently overrides whatever Xero
 * calculated (proven live 2026-09-01, Xero stored 1125 over its own 875), and
 * zero is a supplied amount.
 */
export async function xeroCreateDraftInvoice(org: OrgCode, input: XeroDraftInput): Promise<XeroCall<XeroDraftResult>> {
  const res = await callXero<XeroDraftResult & { ok: true }>(org, { action: 'create_draft_invoice', ...input })
  if (!res.ok) return res
  if (!res.data.xero_draft_invoice_id || !Array.isArray(res.data.lines)) {
    return { ok: false, error: 'Xero returned a draft with no id or no lines.' }
  }
  return { ok: true, data: res.data }
}
