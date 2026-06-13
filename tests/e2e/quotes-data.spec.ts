import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

// HubSpot-backed Quotes specs. READ-ONLY by design: they load pages and assert
// the mandatory probability-of-close field RENDERS. They deliberately NEVER click
// "Start Quote" or submit — those write win_probability to HubSpot + upsert
// deals_registry. Runs as any usable persona (prefers admin; Jillian also has
// quotes access and owns the deals).
const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN
const dealId = process.env.E2E_DEAL_ID
const c = anyCreds()

test.describe('Quotes — read-only, HubSpot-backed', () => {
  test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, c!)
  })

  test('the quote requests queue loads', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed queue')
    await page.goto('/quotes/requests')
    await expect(page.getByRole('heading', { name: 'Incoming Quote Requests' })).toBeVisible()
  })

  test('quote-create shows the mandatory probability-of-close field (no submission)', async ({ page }) => {
    test.skip(!hasToken || !dealId, 'Set HUBSPOT_ACCESS_TOKEN + E2E_DEAL_ID (a real deal) to run')
    await page.goto(`/quotes/create/${dealId}`)
    // The setup dialog opens by default.
    await expect(page.getByText('Quote Setup')).toBeVisible()
    // The backbone field is present and marked required (the "*" label, not the
    // select placeholder which also contains "probability").
    await expect(page.getByText('Win Probability *')).toBeVisible()
    // Guardrail: do NOT proceed — clicking "Start Quote" would PATCH win_probability
    // to the live HubSpot deal. Asserting presence only.
    await expect(page.getByRole('button', { name: /Start Quote/i })).toBeVisible()
  })
})
