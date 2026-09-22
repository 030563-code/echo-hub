import { test, expect } from '@playwright/test'
import { adminCreds, login } from './helpers'

/**
 * France invoices through the Hub. Dean, 22 Sep 2026.
 *
 * Until today the Accepted Quotes queue told every organisation but the USA
 * "Invoicing for X is not set up in the Hub yet." France now has an invoicing
 * profile (EUR, a Xero draft where TaxJar stands), so its queue is live and its
 * numbering tab is named for what that step does. Canada is unchanged and
 * still says so, which is the control.
 *
 * Read only: switching organisation sets a cookie and nothing else, and no
 * invoice is opened. The queue is empty for France today (no EURO deal has
 * reached Quotation Accepted since the stage-history trigger began), so this
 * proves the door and the wording, not a document.
 */
test.describe('France invoicing is live in the Hub', () => {
  const c = adminCreds()
  test.skip(!c, 'Set E2E_USERNAME/E2E_PASSWORD to run the France invoicing path')

  test.beforeEach(async ({ page }) => {
    await login(page, c!)
  })

  test('the France queue has no "not set up" banner and names its numbering tab for the number', async ({ page }) => {
    await page.goto('/invoicing/accepted')
    await page.locator('aside').getByRole('link', { name: 'France', exact: true }).click()
    await expect(page).toHaveURL(/\/invoicing\/accepted/)
    await expect(page.getByTestId('active-organisation')).toHaveText(/France/)

    await expect(page.getByRole('heading', { name: 'Accepted Quotes' })).toBeVisible()
    await expect(page.getByText('Invoicing for France is not set up in the Hub yet.')).toHaveCount(0)

    // Same step, different engine: Dave files with TaxJar, Claire just numbers.
    const nav = page.getByRole('navigation', { name: 'Invoicing' })
    await expect(nav.getByRole('link', { name: 'Invoice numbered' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'TaxJar order transaction created' })).toHaveCount(0)
  })

  test('Canada is unchanged: still for reference only, still says so', async ({ page }) => {
    await page.goto('/invoicing/accepted')
    await page.locator('aside').getByRole('link', { name: 'Canada', exact: true }).click()
    await expect(page.getByTestId('active-organisation')).toHaveText(/Canada/)
    await expect(page.getByText('Invoicing for Canada is not set up in the Hub yet.')).toBeVisible()
  })

  test('the USA is unchanged: TaxJar wording on the tab, no banner', async ({ page }) => {
    await page.goto('/invoicing/accepted')
    await page.locator('aside').getByRole('link', { name: 'USA', exact: true }).click()
    await expect(page.getByTestId('active-organisation')).toHaveText(/USA/)
    await expect(page.getByText(/is not set up in the Hub yet/)).toHaveCount(0)
    const nav = page.getByRole('navigation', { name: 'Invoicing' })
    await expect(nav.getByRole('link', { name: 'TaxJar order transaction created' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Invoice numbered' })).toHaveCount(0)
  })
})
