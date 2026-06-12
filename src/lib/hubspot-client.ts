import 'server-only'

/**
 * Rate-limit-aware fetch wrapper for the HubSpot API. Ported from the sales-hub.
 *
 * HubSpot enforces per-app rate limits and returns HTTP 429 (with a `Retry-After`
 * header, in seconds) when exceeded. Transient 5xx responses also occur. This
 * wrapper retries 429/5xx with exponential backoff (honouring `Retry-After`),
 * and centralises the Authorization header.
 *
 * Server-only: reads HUBSPOT_ACCESS_TOKEN; can never be bundled to the client.
 */

const HUBSPOT_TOKEN_ENV = 'HUBSPOT_ACCESS_TOKEN'
const DEFAULT_RETRIES = 3
const MAX_BACKOFF_MS = 8000

export class HubSpotConfigError extends Error {}

export interface HubSpotFetchOptions extends Omit<RequestInit, 'cache'> {
  /** Number of retry attempts on 429/5xx. Default 3. */
  retries?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Perform an authenticated HubSpot request with retry/backoff.
 * Throws HubSpotConfigError if the access token is missing.
 */
export async function hubspotFetch(url: string, options: HubSpotFetchOptions = {}): Promise<Response> {
  const accessToken = process.env[HUBSPOT_TOKEN_ENV]
  if (!accessToken) {
    throw new HubSpotConfigError('HubSpot Access Token not configured')
  }

  const { retries = DEFAULT_RETRIES, headers, body, ...rest } = options

  // Don't set Content-Type for FormData — the runtime sets the multipart boundary.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  const mergedHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...((headers as Record<string, string>) ?? {}),
  }

  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      ...rest,
      body,
      headers: mergedHeaders,
      cache: 'no-store',
    })

    // Success or non-retryable client error → return immediately.
    if (response.status !== 429 && response.status < 500) {
      return response
    }

    lastResponse = response
    if (attempt === retries) break

    const retryAfterHeader = Number(response.headers.get('Retry-After'))
    const backoffMs =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)

    await sleep(backoffMs)
  }

  // Exhausted retries — return the last (failed) response so callers handle it.
  return lastResponse as Response
}
