import 'server-only'

/**
 * TaxJar API client (sales-tax calculation + transaction recording for
 * filing). Mirrors hubspotFetch's retry semantics: 429/5xx retried with
 * exponential backoff honouring Retry-After; 4xx surfaced as TaxJarError with
 * TaxJar's own `detail` message verbatim (their validation errors are
 * actionable and the reviewer should see them).
 *
 * Environment: setting TAXJAR_API_TOKEN switches everything to production
 * (api.taxjar.com); with only TAXJAR_SANDBOX_TOKEN set it stays on the
 * sandbox. TAXJAR_API_BASE overrides the host and must agree with the token. The sandbox validates request/response formats but does NOT
 * return accurate rates, and its transaction endpoints return stubbed
 * responses.
 */

import type { TaxJarTaxRequest, TaxJarTaxResponse } from '@/lib/customer-invoice/tax-mapping'

const SANDBOX_BASE = 'https://api.sandbox.taxjar.com'
const PRODUCTION_BASE = 'https://api.taxjar.com'
const DEFAULT_RETRIES = 3
const MAX_BACKOFF_MS = 8000

export class TaxJarConfigError extends Error {}

export class TaxJarError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(detail)
    this.name = 'TaxJarError'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function config(): { base: string; token: string } {
  const productionToken = process.env.TAXJAR_API_TOKEN
  const sandboxToken = process.env.TAXJAR_SANDBOX_TOKEN
  const explicitBase = process.env.TAXJAR_API_BASE

  // The PRESENCE of a production token is the go-live switch, so setting it is
  // enough to leave the sandbox. Deciding on the base URL instead would have
  // meant that setting only TAXJAR_API_TOKEN (what the runbook says to do)
  // silently kept billing customers sandbox rates, which are plausible but
  // wrong and return HTTP 200.
  if (productionToken) {
    const base = explicitBase || PRODUCTION_BASE
    if (base.includes('sandbox')) {
      throw new TaxJarConfigError(
        'TAXJAR_API_TOKEN is set (production) but TAXJAR_API_BASE points at the sandbox. Clear the base override, or unset the production token to stay on the sandbox.',
      )
    }
    return { base, token: productionToken }
  }

  const base = explicitBase || SANDBOX_BASE
  if (!base.includes('sandbox')) {
    throw new TaxJarConfigError(
      'TAXJAR_API_BASE points at the production TaxJar endpoint but TAXJAR_API_TOKEN is not configured (the sandbox token is deliberately not used as a fallback: its rates are not accurate).',
    )
  }
  if (!sandboxToken) throw new TaxJarConfigError('TAXJAR_SANDBOX_TOKEN is not configured')
  return { base, token: sandboxToken }
}

async function taxjarFetch(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  const { base, token } = config()
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
    })

    if (response.status !== 429 && response.status < 500) return response

    lastResponse = response
    if (attempt === DEFAULT_RETRIES) break

    const retryAfterHeader = Number(response.headers.get('Retry-After'))
    const backoffMs =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)
    await sleep(backoffMs)
  }

  return lastResponse as Response
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; error?: string }
    return body.detail || body.error || `TaxJar request failed (HTTP ${response.status})`
  } catch {
    return `TaxJar request failed (HTTP ${response.status})`
  }
}

/** POST /v2/taxes — synchronous sales-tax calculation. */
export async function taxjarCalculateTax(request: TaxJarTaxRequest): Promise<TaxJarTaxResponse> {
  const response = await taxjarFetch('/v2/taxes', { method: 'POST', body: request })
  if (!response.ok) throw new TaxJarError(response.status, await readError(response))
  return (await response.json()) as TaxJarTaxResponse
}

export interface TaxJarOrderLineItem {
  id: string
  quantity: number
  product_identifier?: string
  description?: string
  unit_price: number
  discount?: number
  sales_tax: number
}

export interface TaxJarOrderRequest {
  transaction_id: string
  transaction_date: string
  from_country: string
  from_state: string
  from_zip: string
  from_city?: string
  from_street?: string
  to_country: string
  to_state: string
  to_zip: string
  to_city?: string
  to_street?: string
  /** Order total with shipping, EXCLUDING sales tax (API-enforced: must equal
   *  the sum of line_items plus shipping). */
  amount: number
  shipping: number
  sales_tax: number
  customer_id?: string
  line_items?: TaxJarOrderLineItem[]
}

/**
 * POST /v2/transactions/orders — records a completed order for TaxJar's
 * reporting/filing. Calculates nothing. A duplicate transaction_id returns
 * 422, in which case the record is updated via PUT instead.
 */
export async function taxjarCreateOrder(order: TaxJarOrderRequest): Promise<unknown> {
  const created = await taxjarFetch('/v2/transactions/orders', { method: 'POST', body: order })
  if (created.ok) return await created.json()

  if (created.status === 422) {
    const updated = await taxjarFetch(`/v2/transactions/orders/${encodeURIComponent(order.transaction_id)}`, {
      method: 'PUT',
      body: order,
    })
    if (updated.ok) return await updated.json()
    throw new TaxJarError(updated.status, await readError(updated))
  }

  throw new TaxJarError(created.status, await readError(created))
}

export interface TaxJarZipRate {
  zip: string
  state: string
  city: string | null
  county: string | null
  combined_rate: number
  freight_taxable: boolean
}

/**
 * GET /v2/rates/{zip} — the jurisdiction a zip resolves to.
 *
 * This is the only TaxJar call that needs nothing but a zip: /v2/taxes refuses
 * a US request without BOTH to_zip and to_state ("No to state/province,
 * required when country is US"). So a zip alone cannot price an invoice, but
 * it CAN complete an address, which is what the acceptance gate uses it for.
 *
 * Use it to prefill and to verify, never to price: a zip can straddle tax
 * districts and the street decides which one. The authoritative number is
 * always the /v2/taxes response for the full address.
 */
export async function taxjarRatesForZip(zip: string): Promise<TaxJarZipRate | null> {
  const clean = zip.trim().replace(/\s+/g, '')
  if (!/^\d{5}(-\d{4})?$/.test(clean)) return null
  // The rates endpoint keys on the 5-digit zip; a ZIP+4 suffix 404s.
  const response = await taxjarFetch(`/v2/rates/${encodeURIComponent(clean.slice(0, 5))}`, { method: 'GET' })
  if (response.status === 404) return null
  if (!response.ok) throw new TaxJarError(response.status, await readError(response))

  const body = (await response.json()) as {
    rate?: {
      zip?: string
      state?: string
      city?: string | null
      county?: string | null
      combined_rate?: string | number
      freight_taxable?: boolean
    }
  }
  const rate = body.rate
  if (!rate?.state) return null

  // TaxJar returns city and county UPPERCASED, and null where a state has no
  // local component (Maryland's flat 6%, for instance).
  const titleCase = (v: string | null | undefined) =>
    v ? v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null

  return {
    zip: String(rate.zip ?? clean.slice(0, 5)),
    state: String(rate.state).toUpperCase(),
    city: titleCase(rate.city),
    county: titleCase(rate.county),
    combined_rate: Number(rate.combined_rate ?? 0),
    freight_taxable: rate.freight_taxable === true,
  }
}

/**
 * GET /v2/nexus/regions — the states TaxJar will actually collect for.
 *
 * Read live rather than mirrored in code, so switching Maryland on in the
 * TaxJar account is the only action needed to clear the registered-but-held
 * block. Compare against US_REGISTERED_STATES, never assume the two match.
 */
export async function taxjarNexusRegions(): Promise<string[]> {
  const response = await taxjarFetch('/v2/nexus/regions', { method: 'GET' })
  if (!response.ok) throw new TaxJarError(response.status, await readError(response))
  const body = (await response.json()) as { regions?: { region_code?: string; country_code?: string }[] }
  return (body.regions ?? [])
    .filter((r) => (r.country_code ?? 'US').toUpperCase() === 'US')
    .map((r) => String(r.region_code ?? '').toUpperCase())
    .filter(Boolean)
}
