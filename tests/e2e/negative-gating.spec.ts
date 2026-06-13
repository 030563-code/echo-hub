import { test, expect } from '@playwright/test'
import { login, limitedCreds } from './helpers'

// Negative capability gating: a SCOPED user must NOT see modules they lack the
// capability for, and must be redirected away from those routes. Supply a
// quotes-only user via E2E_LIMITED_USERNAME / E2E_LIMITED_PASSWORD (your existing
// non-admin already fits — quotes.view + quotes.create, no ops modules). No user
// is created by the test — bring your own creds.
const limited = limitedCreds()

test.describe('Negative capability gating (scoped user)', () => {
  test.skip(!limited.email || !limited.password, 'Set E2E_LIMITED_USERNAME/PASSWORD (a quotes-only user) to run')

  test.beforeEach(async ({ page }) => {
    await login(page, limited.email!, limited.password!)
  })

  test('scoped user sees Quotes but NOT the ops boards', async ({ page }) => {
    const nav = page.locator('aside')
    await expect(nav.getByRole('link', { name: 'Quotes', exact: true })).toBeVisible()
    for (const hidden of ['MRP', 'Transport', 'Purchase Orders', 'Bill of Materials']) {
      await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0)
    }
  })

  test('dashboard offers no forbidden module cards', async ({ page }) => {
    const main = page.getByRole('main')
    for (const hidden of ['MRP', 'Transport', 'Purchase Orders', 'Bill of Materials']) {
      await expect(main.getByRole('link', { name: hidden, exact: true })).toHaveCount(0)
    }
  })

  test('visiting a forbidden module (/mrp) redirects to the dashboard', async ({ page }) => {
    await page.goto('/mrp')
    await expect(page).toHaveURL('http://localhost:3000/')
  })

  test('visiting Quotes (allowed) is NOT redirected to the dashboard or login', async ({ page }) => {
    await page.goto('/quotes')
    await expect(page).toHaveURL(/\/quotes(\/requests)?$/)
  })
})
