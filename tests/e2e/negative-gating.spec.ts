import { test, expect } from '@playwright/test'
import { login, limitedCreds, canSeeMrp } from './helpers'

// Negative capability gating — requires the SCOPED persona (e.g. Jillian:
// quotes-only). Configure via E2E_LIMITED_USERNAME / E2E_LIMITED_PASSWORD.
// Self-skips if not configured, or if that user turns out to be privileged.
const limited = limitedCreds()

test.describe('Negative capability gating (scoped user)', () => {
  test.skip(!limited, 'Set E2E_LIMITED_USERNAME/PASSWORD (a quotes-only user, e.g. Jillian)')

  test.beforeEach(async ({ page }) => {
    await login(page, limited!)
    test.skip(await canSeeMrp(page), 'E2E_LIMITED_* is privileged (sees MRP) — supply a quotes-only user')
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

  test('visiting Quotes (allowed) is NOT redirected away', async ({ page }) => {
    await page.goto('/quotes')
    await expect(page).toHaveURL(/\/quotes(\/requests)?$/)
  })
})
