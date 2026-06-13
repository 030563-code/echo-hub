import { test, expect } from '@playwright/test'
import { login } from './helpers'

// HubSpot-backed Quotes specs. READ-ONLY by design: they load the requests queue
// and assert the mandatory probability-of-close field RENDERS. They deliberately
// NEVER click "Start Quote" or submit — those write win_probability to HubSpot +
// upsert deals_registry. Requires HUBSPOT_ACCESS_TOKEN on the dev server and
// E2E_DEAL_ID (a real deal in the test user's pipeline) to run.
const dealId = process.env.E2E_DEAL_ID

test.describe('Quotes — read-only, HubSpot-backed', () => {
  test.skip(!dealId, 'Set E2E_DEAL_ID + HUBSPOT_ACCESS_TOKEN to run (read-only; never submits)')

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('the quote requests queue loads', async ({ page }) => {
    await page.goto('/quotes/requests')
    await expect(page.getByRole('heading', { name: 'Incoming Quote Requests' })).toBeVisible()
  })

  test('quote-create shows the mandatory probability-of-close field (no submission)', async ({ page }) => {
    await page.goto(`/quotes/create/${dealId}`)
    // The setup dialog opens by default.
    await expect(page.getByText('Quote Setup')).toBeVisible()
    // The backbone field is present and marked required.
    await expect(page.getByText(/Win Probability/i)).toBeVisible()
    // Guardrail: do NOT proceed — clicking "Start Quote" would PATCH win_probability
    // to the live HubSpot deal. Asserting presence only.
    await expect(page.getByRole('button', { name: /Start Quote/i })).toBeVisible()
  })
})
