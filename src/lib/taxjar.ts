import 'server-only'

/**
 * TaxJar API client (sales-tax calculation + transaction recording for
 * filing). Mirrors hubspotFetch's retry semantics: 429/5xx retried with
 * exponential backoff honouring Retry-After; 4xx surfaced as TaxJarError with
 * TaxJar's own `detail` message verbatim (their validation errors are
 * actionable and the reviewer should see them).
 *
 * Environment: TAXJAR_API_TOKEN + TAXJAR_API_BASE for production
 * (https://api.taxjar.com); until then TAXJAR_SANDBOX_TOKEN against the
 * sandbox default. The sandbox validates request/response formats but does NOT
 * return accurate rates, and its transaction endpoints return stubbed
 * responses.
 */

import type { TaxJarTaxRequest, TaxJarTaxResponse } from '@/lib/customer-invoice/tax-mapping'

const DEFAULT_BASE = 'https://api.sandbox.taxjar.com'
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
  const base = process.env.TAXJAR_API_BASE || DEFAULT_BASE
  const token = process.env.TAXJAR_API_TOKEN || process.env.TAXJAR_SANDBOX_TOKEN
  if (!token) throw new TaxJarConfigError('TaxJar API token not configured')
  return { base, token }
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
