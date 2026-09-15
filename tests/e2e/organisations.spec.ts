import { test, expect } from '@playwright/test'
import { login, adminCreds, limitedCreds } from './helpers'

/**
 * The organisation switch (Dean, 15 Sep 2026: "a dropdown under each section
 * ... the other users will only be able to see their own dropdown").
 *
 * Read only. Switching organisation sets a cookie and nothing else; no spec
 * here opens an editor or presses a button that writes to HubSpot, Supabase
 * or Xero.
 */

const ALL_SEVEN = ['USA', 'Canada', 'France', 'SRO', 'Group', 'Australia', 'UK']

test.describe('Organisations (privileged user)', () => {
  const admin = adminCreds()
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD (a super-admin) to run the positive path')

  test.beforeEach(async ({ page }) => {
    await login(page, admin!)
  })

  test('the header names the active organisation', async ({ page }) => {
    await expect(page.getByTestId('active-organisation')).toBeVisible()
  })

  test('Invoicing lists every organisation, opened by being in the module', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Invoicing', exact: true }).click()
    await expect(page).toHaveURL(/\/invoicing/)
    const chevron = page.locator('aside').getByRole('button', { name: 'Organisations for Invoicing' })
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    for (const org of ALL_SEVEN) {
      await expect(page.locator('aside').getByRole('link', { name: org, exact: true })).toBeVisible()
    }
  })

  test('switching to Canada changes the badge and the queue', async ({ page }) => {
    await page.goto('/invoicing/accepted')
    await page.locator('aside').getByRole('link', { name: 'Canada', exact: true }).click()
    await expect(page).toHaveURL(/\/invoicing/)
    await expect(page.getByTestId('active-organisation')).toHaveText(/Canada/)
    // Dean, 15 Sep 2026: the structure now, USA live. Canada's queue is for
    // reference until its own flow exists, and the page says so.
    await expect(page.getByText('Invoicing for Canada is not set up in the Hub yet.')).toBeVisible()

    await page.locator('aside').getByRole('link', { name: 'USA', exact: true }).click()
    await expect(page.getByTestId('active-organisation')).toHaveText(/USA/)
    await expect(page.getByText('Invoicing for Canada is not set up in the Hub yet.')).toHaveCount(0)
  })

  test('Quotes lists only the organisations with a sales pipeline', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Quotes', exact: true }).click()
    await expect(page).toHaveURL(/\/quotes/)
    const aside = page.locator('aside')
    await expect(aside.getByRole('button', { name: 'Organisations for Quotes' })).toHaveAttribute('aria-expanded', 'true')
    for (const org of ['USA', 'Canada', 'France', 'Group', 'Australia', 'UK']) {
      await expect(aside.getByRole('link', { name: org, exact: true })).toBeVisible()
    }
    // s.r.o. manufactures; it has no pipeline and no entry here.
    await expect(aside.getByRole('link', { name: 'SRO', exact: true })).toHaveCount(0)
  })
})

test.describe('Organisations (single-organisation user)', () => {
  const limited = limitedCreds()
  test.skip(!limited, 'Set E2E_LIMITED_USERNAME/E2E_LIMITED_PASSWORD to run the scoped path')

  test('sees no organisation list, wears a badge, and cannot switch by URL', async ({ page }) => {
    await login(page, limited!)
    // One organisation is nothing to choose between.
    await expect(page.locator('aside').getByRole('button', { name: /^Organisations for / })).toHaveCount(0)
    const badge = page.getByTestId('active-organisation')
    await expect(badge).toBeVisible()
    const before = ((await badge.textContent()) ?? '').trim()

    // Australia is Jack's, the AI agent's: no human persona holds it. The
    // switch is refused with a redirect home and the badge is unchanged.
    await page.goto('/org/EB-AUSTRALIA?next=/invoicing')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('active-organisation')).toHaveText(before)
  })
})
