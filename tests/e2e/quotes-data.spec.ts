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

  test('the deals queue loads', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed queue')
    await page.goto('/quotes/deals')
    await expect(page.getByRole('heading', { name: 'Incoming Deals' })).toBeVisible()
  })

  test('the old /quotes/requests path still lands on the deals queue', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed queue')
    // The redirect stub is a two-line page that a future cleanup could easily
    // mistake for dead code. This assertion is what keeps old bookmarks alive.
    await page.goto('/quotes/requests')
    await expect(page).toHaveURL(/\/quotes\/deals$/)
  })

  test('the board shows real HubSpot stages, not one invented status', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed board')
    // The whole point of replacing the Pending tab: a Tender deal used to read
    // "Pending" in grey, the same as a General pricing one.
    await page.goto('/quotes/board')
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible()
    for (const stage of ['Quote Request', 'Tender', 'General pricing']) {
      await expect(page.getByText(stage, { exact: true }).first()).toBeVisible()
    }
    // A column heading must never be a raw stage GUID.
    await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-/)).toHaveCount(0)
  })

  test('/quotes/pending redirects to the board, so old bookmarks still work', async ({ page }) => {
    // Same reasoning as the /quotes/requests stub below: reps bookmark tabs,
    // and the page behind this one is deliberately gone.
    await page.goto('/quotes/pending')
    await expect(page).toHaveURL(/\/quotes\/board$/)
  })

  test('quote-create shows the mandatory probability-of-close field (no submission)', async ({ page }) => {
    test.skip(!hasToken || !dealId, 'Set HUBSPOT_ACCESS_TOKEN + E2E_DEAL_ID (a real deal) to run')
    await page.goto(`/quotes/create/${dealId}`)
    // The setup dialog opens by default.
    await expect(page.getByText('Quote Setup')).toBeVisible()
    // The backbone field is present and marked required (the "*" label, not the
    // select placeholder which also contains "probability").
    await expect(page.getByText('Win Probability *')).toBeVisible()
    // Guardrail: do NOT proceed past setup. win_probability now PATCHes to the
    // live HubSpot deal on the Generate step, not on "Start Quote" — but this
    // spec stays read-only regardless. Asserting presence only.
    await expect(page.getByRole('button', { name: /Start Quote/i })).toBeVisible()
  })
})
