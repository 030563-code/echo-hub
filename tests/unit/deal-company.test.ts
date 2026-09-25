import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The company a deal is invoiced to, read from HubSpot when deals_registry has
 * none. Every id is invented.
 */

const fetcher = vi.hoisted(() => ({ fn: vi.fn() }))

vi.mock('@/lib/hubspot-client', () => ({ hubspotFetch: fetcher.fn }))

import { fetchDealCompanyId, primaryDealCompanyId } from '@/lib/customer-invoice/deal-company'

const primary = { category: 'HUBSPOT_DEFINED', typeId: 5, label: 'Primary' }
const plain = { category: 'HUBSPOT_DEFINED', typeId: 341, label: null }

beforeEach(() => {
  fetcher.fn.mockReset()
})

describe('which company a deal is invoiced to', () => {
  it('takes the primary company, wherever it sits in the list', () => {
    expect(
      primaryDealCompanyId([
        { toObjectId: 880001, associationTypes: [plain] },
        { toObjectId: 880002, associationTypes: [plain, primary] },
      ]),
    ).toBe('880002')
  })

  it('takes the only company when none is marked primary', () => {
    expect(primaryDealCompanyId([{ toObjectId: '880003', associationTypes: [plain] }])).toBe('880003')
  })

  it('refuses to guess between several companies with no primary', () => {
    expect(
      primaryDealCompanyId([
        { toObjectId: 880001, associationTypes: [plain] },
        { toObjectId: 880002, associationTypes: [plain] },
      ]),
    ).toBeNull()
  })

  it('does not take a label someone made as the primary, even with the same number', () => {
    expect(
      primaryDealCompanyId([
        { toObjectId: 880001, associationTypes: [{ category: 'USER_DEFINED', typeId: 5, label: 'Billing' }] },
        { toObjectId: 880002, associationTypes: [plain] },
      ]),
    ).toBeNull()
  })

  it('answers nothing for a deal with no company', () => {
    expect(primaryDealCompanyId([])).toBeNull()
  })
})

describe('reading it from HubSpot', () => {
  it('asks for the deal\'s company associations and returns the primary one', async () => {
    fetcher.fn.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ toObjectId: 880004, associationTypes: [primary] }] }), { status: 200 }),
    )
    expect(await fetchDealCompanyId('990001')).toBe('880004')
    expect(fetcher.fn).toHaveBeenCalledWith(
      'https://api.hubapi.com/crm/v4/objects/deals/990001/associations/companies?limit=100',
    )
  })

  it('fails soft: an error answer or a thrown call is no company, never an exception', async () => {
    fetcher.fn.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    expect(await fetchDealCompanyId('990001')).toBeNull()
    fetcher.fn.mockRejectedValueOnce(new Error('HubSpot Access Token not configured'))
    expect(await fetchDealCompanyId('990001')).toBeNull()
  })
})
