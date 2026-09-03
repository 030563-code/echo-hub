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
    // Pipeline-agnostic on purpose: the persona may sit in any region, and the
    // board shows THEIR pipeline's stages. What must hold everywhere is that a
    // column is a real HubSpot stage name.
    await page.goto('/quotes/board')
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible()
    await expect(page.getByText('Your profile has no region set')).toHaveCount(0)
    // Never a raw stage GUID, and never the invented status this replaced: the
    // old tab painted Tender and General pricing alike as "Pending".
    await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-/)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Pending', exact: true })).toHaveCount(0)
    // Closed won and Closed lost exist in every sales pipeline the Hub knows.
    await expect(page.getByRole('heading', { name: /^Closed/i }).first()).toBeVisible()
  })

  test('an admin can point the board at the USA pipeline and gets its own stages', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed board')
    await page.goto('/quotes/board?pipeline=dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc')
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible()
    // Only a privileged persona may switch pipeline; a scoped one is put back
    // in its own region, which is the control working rather than a failure.
    const isAdmin = await page.getByRole('link', { name: 'All reps' }).count()
    test.skip(isAdmin === 0, 'Needs the privileged persona to switch pipeline')
    // Verified live: USA SALES carries these, and Tender is exactly the stage
    // the old Pending tab used to hide.
    for (const stage of ['Quote Request', 'Tender', 'General pricing']) {
      // By role: every stage name also appears inside each card's collapsed
      // Move menu, so a plain text match finds a hidden button first.
      await expect(page.getByRole('heading', { name: stage, exact: true })).toBeVisible()
    }
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
