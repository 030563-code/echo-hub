import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

/**
 * Dates read in US form, "September 5, 2026".
 *
 * The app default used to be en-GB ("05 Sep 2026") and the customer invoice PDF
 * printed "5 September 2026", which is the wrong way round for a US business.
 *
 * READ-ONLY: it loads a deal page and reads text.
 */
const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN
const dealId = process.env.E2E_DEAL_ID
const c = anyCreds()

/** "5 September 2026" and "05 Sep 2026", the day-first forms that must not
 *  appear anywhere a person reads. */
const DAY_FIRST = /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/

test.describe('US date formatting', () => {
  test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')

  test('a deal page shows month-first dates and no day-first ones', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed deal page')
    test.skip(!dealId, 'Set E2E_DEAL_ID to a deal the persona can open')

    await login(page, c!)
    await page.goto(`/quotes/deals/${dealId}`)

    await expect(page.getByText(/^Created:/)).toContainText(/[A-Z][a-z]+ \d{1,2}, \d{4}/)

    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(DAY_FIRST)
  })
})
