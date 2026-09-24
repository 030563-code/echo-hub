import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDateForHubSpot, closeDayForInput, closeDayProblem, todayUtc } from '@/lib/close-date'
import { parseDealWizardDraft } from '@/lib/deal-wizard-draft'

/**
 * Dean, 24 Sep 2026: "Okay add a close date field in the Hub please."
 *
 * The rule, the one action that writes it (with HubSpot mocked: nothing here reaches the CRM), and
 * the three places it is offered. Every id and date is invented.
 */

const NOW = Date.parse('2026-09-24T15:00:00Z')

describe('close-date: what the Hub writes and what it refuses', () => {
  it('writes midday UTC, so the calendar day is the same in every office', () => {
    expect(closeDateForHubSpot('2026-10-31')).toBe('2026-10-31T12:00:00.000Z')
  })

  it('reads a HubSpot close date back as its UTC day, and nothing as empty', () => {
    expect(closeDayForInput('2026-10-31T12:00:00.000Z')).toBe('2026-10-31')
    expect(closeDayForInput('2026-10-31T04:00:00Z')).toBe('2026-10-31')
    expect(closeDayForInput(null)).toBe('')
    expect(closeDayForInput('')).toBe('')
  })

  it('refuses what is not a real day, and what is out of range', () => {
    expect(closeDayProblem('', NOW)).toBe('Pick a close date.')
    expect(closeDayProblem('31/10/2026', NOW)).toBe('Pick a close date.')
    expect(closeDayProblem('2026-02-30', NOW)).toBe('That is not a real date.')
    expect(closeDayProblem('2014-12-31', NOW)).toMatch(/before 2015-01-01/)
    expect(closeDayProblem('2031-09-25', NOW)).toMatch(/more than 5 years ahead/)
  })

  it('takes a past day, today and a day years out', () => {
    for (const day of ['2025-01-15', '2026-09-24', '2031-09-24']) expect(closeDayProblem(day, NOW), day).toBeNull()
    expect(todayUtc(NOW)).toBe('2026-09-24')
  })
})

// The action, with everything around it mocked. HubSpot is never called for real.
const calls: { url: string; options: { method?: string; body?: string } }[] = []
let access: { ok: true } | { ok: false; error: string } = { ok: true }
let staging = false
let hubspotStatus = 200
const revalidated: unknown[][] = []

vi.mock('@/lib/authz', () => ({ assertDealAccess: vi.fn(async () => access) }))
vi.mock('@/lib/env', () => ({ externalCallsDisabled: () => staging, STAGING_SKIP_NOTE: 'Staging: nothing is written.' }))
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => void revalidated.push(args) }))
vi.mock('@/lib/hubspot-client', () => ({
  HubSpotConfigError: class HubSpotConfigError extends Error {},
  hubspotFetch: vi.fn(async (url: string, options: { method?: string; body?: string }) => {
    calls.push({ url, options })
    return new Response(hubspotStatus === 200 ? '{}' : 'nope', { status: hubspotStatus })
  }),
}))

const { updateDealCloseDate } = await import('@/app/actions/hubspot/updateDealCloseDate')

describe('updateDealCloseDate', () => {
  beforeEach(() => {
    calls.length = 0
    revalidated.length = 0
    access = { ok: true }
    staging = false
    hubspotStatus = 200
  })

  it('patches closedate and nothing else, then refreshes the deal and the banner', async () => {
    const res = await updateDealCloseDate({ dealId: '1234567', closeDay: '2026-10-31' })
    expect(res).toEqual({ success: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.hubapi.com/crm/v3/objects/deals/1234567')
    expect(calls[0].options.method).toBe('PATCH')
    expect(JSON.parse(calls[0].options.body ?? '{}')).toEqual({ properties: { closedate: '2026-10-31T12:00:00.000Z' } })
    expect(revalidated).toEqual([['/quotes/deals/1234567'], ['/quotes', 'layout']])
  })

  it('writes nothing for a caller the deal check refuses', async () => {
    access = { ok: false, error: 'Forbidden: deal is outside your pipeline' }
    const res = await updateDealCloseDate({ dealId: '1234567', closeDay: '2026-10-31' })
    expect(res).toEqual({ success: false, error: 'Forbidden: deal is outside your pipeline' })
    expect(calls).toHaveLength(0)
  })

  it('writes nothing for a day that is not one, before it even checks the deal', async () => {
    const res = await updateDealCloseDate({ dealId: '1234567', closeDay: '2026-13-01' })
    expect(res.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('writes nothing on staging', async () => {
    staging = true
    const res = await updateDealCloseDate({ dealId: '1234567', closeDay: '2026-10-31' })
    expect(res).toEqual({ success: false, error: 'Staging: nothing is written.' })
    expect(calls).toHaveLength(0)
  })

  it('says so when HubSpot refuses, and refreshes nothing', async () => {
    hubspotStatus = 400
    const res = await updateDealCloseDate({ dealId: '1234567', closeDay: '2026-10-31' })
    expect(res).toEqual({ success: false, error: 'HubSpot did not take the new close date. Try again.' })
    expect(revalidated).toHaveLength(0)
  })
})

describe('where the close date is offered', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('the deal page shows it, editable only while the deal is open and for someone who can change it', () => {
    const page = read('src/app/(dashboard)/quotes/deals/[id]/page.tsx')
    expect(page).toContain('<CloseDateField')
    expect(page).toContain('canEdit={canChangeStage && !dealIsClosed}')
  })

  it('the past-close banner offers it on each row to quotes.create holders, and keeps HubSpot for the rest', () => {
    const banner = read('src/components/quotes/past-close-banner.tsx')
    expect(banner).toContain("auth.capabilities.has('quotes.create')")
    expect(banner).toMatch(/\{canEdit && \(\s*<CloseDateField dealId=\{deal\.id\}/)
    expect(banner).toContain("'Change the date in HubSpot'")
  })

  it('a new deal sends one only when it was given one, checked on the server too', () => {
    const create = read('src/app/actions/hubspot/createDeal.ts')
    expect(create).toContain('...(closeDay ? { closedate: closeDateForHubSpot(closeDay) } : {})')
    expect(create).toContain('closeDayProblem(closeDay, Date.now())')
  })

  it('a create-deal draft saved before the field existed still loads', () => {
    const old = {
      v: 1,
      step: 3,
      companyName: 'Example Ltd',
      selectedCompany: null,
      contactName: '',
      contactEmail: '',
      selectedContact: null,
      dealName: 'Example deal',
      description: '',
      currency: 'USD',
    }
    expect(parseDealWizardDraft(old)?.dealName).toBe('Example deal')
    expect(parseDealWizardDraft({ ...old, closeDay: '2026-10-31' })?.closeDay).toBe('2026-10-31')
  })
})
