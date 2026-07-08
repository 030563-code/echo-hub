import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hubEnv, isStaging, externalCallsDisabled } from '@/lib/env'
import { hubspotFetch, HubSpotConfigError } from '@/lib/hubspot-client'

// The staging kill switch: NEXT_PUBLIC_HUB_ENV=staging must both flag the env AND
// stop the HubSpot client from issuing any WRITE, even with a valid token present.
const ORIGINAL_ENV = process.env.NEXT_PUBLIC_HUB_ENV
const ORIGINAL_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_HUB_ENV
  else process.env.NEXT_PUBLIC_HUB_ENV = ORIGINAL_ENV
  if (ORIGINAL_TOKEN === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN
  else process.env.HUBSPOT_ACCESS_TOKEN = ORIGINAL_TOKEN
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('env / staging flag', () => {
  it('defaults to production when the flag is unset', () => {
    delete process.env.NEXT_PUBLIC_HUB_ENV
    expect(hubEnv()).toBe('production')
    expect(isStaging()).toBe(false)
    expect(externalCallsDisabled()).toBe(false)
  })

  it('is staging (external calls disabled) when the flag is "staging"', () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    expect(hubEnv()).toBe('staging')
    expect(isStaging()).toBe(true)
    expect(externalCallsDisabled()).toBe(true)
  })

  it('treats any other value as production', () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'production'
    expect(externalCallsDisabled()).toBe(false)
  })
})

describe('hubspotFetch staging kill switch', () => {
  beforeEach(() => {
    process.env.HUBSPOT_ACCESS_TOKEN = 'test-token' // present, so only staging can block
    vi.stubGlobal('fetch', vi.fn())
  })

  it('blocks a write (POST) in staging BEFORE any network call', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    await expect(
      hubspotFetch('https://api.hubapi.com/crm/v3/objects/deals', { method: 'POST' })
    ).rejects.toBeInstanceOf(HubSpotConfigError)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('blocks PATCH and DELETE writes in staging too', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    await expect(hubspotFetch('https://api.hubapi.com/x', { method: 'PATCH' })).rejects.toBeInstanceOf(HubSpotConfigError)
    await expect(hubspotFetch('https://api.hubapi.com/x', { method: 'DELETE' })).rejects.toBeInstanceOf(HubSpotConfigError)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('still allows a read (GET) in staging', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const response = await hubspotFetch('https://api.hubapi.com/x', { method: 'GET' })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows a write in production (does not block)', async () => {
    delete process.env.NEXT_PUBLIC_HUB_ENV
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const response = await hubspotFetch('https://api.hubapi.com/x', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
