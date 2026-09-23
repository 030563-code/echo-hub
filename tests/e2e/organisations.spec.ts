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

  test('the header flag switches organisation and keeps the page when it can', async ({ page }) => {
    // Dean, 16 Sep 2026: "you should be able to click on the flag at the top
    // next to Echo Barrier Hub to change the current loaded country."
    await page.goto('/invoicing/accepted')
    const badge = page.getByTestId('active-organisation')
    await expect(badge).toHaveAttribute('aria-haspopup', 'menu')
    await badge.click()
    const menu = page.getByRole('menu', { name: 'Organisations' })
    await expect(menu).toBeVisible()
    for (const org of ALL_SEVEN) {
      await expect(menu.getByRole('menuitem', { name: org, exact: true })).toBeVisible()
    }
    await menu.getByRole('menuitem', { name: 'Canada', exact: true }).click()
    // Invoicing has Canada, so the page is kept.
    await expect(page).toHaveURL(/\/invoicing\/accepted/)
    await expect(page.getByTestId('active-organisation')).toHaveText(/Canada/)

    await page.getByTestId('active-organisation').click()
    await page.getByRole('menuitem', { name: 'USA', exact: true }).click()
    await expect(page.getByTestId('active-organisation')).toHaveText(/USA/)
  })

  test('the header flag goes home when the page cannot show the chosen organisation', async ({ page }) => {
    await page.goto('/calls')
    await page.getByTestId('active-organisation').click()
    // s.r.o. takes no phone office, so Calls has nothing to show for it. This
    // used to be Quotes and SRO, until s.r.o. took EURO SALES on 16 Sep 2026.
    await page.getByRole('menuitem', { name: 'SRO', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('active-organisation')).toHaveText(/SRO/)

    await page.getByTestId('active-organisation').click()
    await page.getByRole('menuitem', { name: 'USA', exact: true }).click()
    await expect(page.getByTestId('active-organisation')).toHaveText(/USA/)
  })

  test('the header menu closes on Escape without switching', async ({ page }) => {
    const before = ((await page.getByTestId('active-organisation').textContent()) ?? '').trim()
    await page.getByTestId('active-organisation').click()
    await expect(page.getByRole('menu', { name: 'Organisations' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Organisations' })).toHaveCount(0)
    await expect(page.getByTestId('active-organisation')).toHaveText(before)
  })

  test('Quotes lists every organisation, each of the seven having a sales pipeline', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Quotes', exact: true }).click()
    await expect(page).toHaveURL(/\/quotes/)
    const aside = page.locator('aside')
    await expect(aside.getByRole('button', { name: 'Organisations for Quotes' })).toHaveAttribute('aria-expanded', 'true')
    // s.r.o. included: it manufactures, but since 16 Sep 2026 it shares EURO
    // SALES with France (Juraj quotes in it), so Quotes has something for it.
    for (const org of ALL_SEVEN) {
      await expect(aside.getByRole('link', { name: org, exact: true })).toBeVisible()
    }
  })
})

test.describe('Organisations (single-organisation user)', () => {
  const limited = limitedCreds()
  test.skip(!limited, 'Set E2E_LIMITED_USERNAME/E2E_LIMITED_PASSWORD to run the scoped path')

  test('sees no organisation list, wears a badge, and cannot switch by URL', async ({ page }) => {
    await login(page, limited!)
    // One organisation is nothing to choose between: no sidebar lists, and the
    // header badge is a plain badge, not a menu.
    await expect(page.locator('aside').getByRole('button', { name: /^Organisations for / })).toHaveCount(0)
    const badge = page.getByTestId('active-organisation')
    await expect(badge).toBeVisible()
    await expect(badge).not.toHaveAttribute('aria-haspopup', 'menu')
    const before = ((await badge.textContent()) ?? '').trim()

    // Australia is Jack's, the AI agent's: no human persona holds it. The
    // switch is refused with a redirect home and the badge is unchanged.
    await page.goto('/org/EB-AUSTRALIA?next=/invoicing')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('active-organisation')).toHaveText(before)
  })
})
