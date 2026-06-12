import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hubspotFetch, HubSpotConfigError } from '@/lib/hubspot-client'

const URL = 'https://api.hubapi.com/crm/v3/objects/deals/123'

function res(status: number, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify({ ok: status < 400 }), { status, headers })
}

describe('hubspotFetch (finding #21 — 429/backoff handling)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries on 429 then returns the eventual 200', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))

    const promise = hubspotFetch(URL, { method: 'GET' })
    await vi.runAllTimersAsync()
    const response = await promise

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honours the Retry-After header for backoff timing', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(res(429, { 'Retry-After': '2' })).mockResolvedValueOnce(res(200))

    const promise = hubspotFetch(URL, { method: 'GET', retries: 1 })
    await vi.runAllTimersAsync()
    const response = await promise

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx and gives up after exhausting retries', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(res(503))

    const promise = hubspotFetch(URL, { method: 'GET', retries: 2 })
    await vi.runAllTimersAsync()
    const response = await promise

    expect(response.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('does NOT retry a 4xx (other than 429)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(res(404))

    const promise = hubspotFetch(URL, { method: 'GET', retries: 3 })
    await vi.runAllTimersAsync()
    const response = await promise

    expect(response.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws HubSpotConfigError when the token is missing', async () => {
    const original = process.env.HUBSPOT_ACCESS_TOKEN
    delete process.env.HUBSPOT_ACCESS_TOKEN
    await expect(hubspotFetch(URL)).rejects.toBeInstanceOf(HubSpotConfigError)
    process.env.HUBSPOT_ACCESS_TOKEN = original
  })
})
