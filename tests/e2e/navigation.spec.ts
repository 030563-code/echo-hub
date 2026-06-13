import { test, expect } from '@playwright/test'
import { login } from './helpers'

// dean@corserv.co.uk is a super-admin (the `admin` capability ⇒ all modules), so
// this exercises the full positive RBAC path: every nav item shows and every
// module route renders within the shell. (Negative gating — a scoped user who
// CANNOT see a module — needs a limited test user; see the report.)
test.describe('Navigation + RBAC (super-admin)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('sidebar shows every workstream — and no Weeklies', async ({ page }) => {
    const nav = page.locator('aside')
    for (const label of ['Dashboard', 'Quotes', 'Purchase Orders', 'Bill of Materials', 'Transport', 'MRP']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
    // Regression guard: the standalone Weeklies tracker was removed.
    await expect(nav.getByRole('link', { name: 'Weeklies', exact: true })).toHaveCount(0)
  })

  test('dashboard lists the accessible module cards', async ({ page }) => {
    await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'MRP' })).toBeVisible()
  })

  // Ops boards read prod tables (or degrade gracefully) — they render fully.
  const opsModules = [
    { link: 'MRP', url: /\/mrp$/, heading: 'MRP Prediction Dashboard' },
    { link: 'Transport', url: /\/transport$/, heading: 'Logistics & Shipping' },
    { link: 'Purchase Orders', url: /\/purchase-orders$/, heading: 'Supplier & PO Tracker' },
    { link: 'Bill of Materials', url: /\/bom$/, heading: 'Bill of Materials & Pricing' },
  ]
  for (const m of opsModules) {
    test(`admin can open ${m.link}`, async ({ page }) => {
      // Scope to the sidebar — the dashboard ALSO renders a module card with the
      // same link text, which would be a strict-mode ambiguity.
      await page.locator('aside').getByRole('link', { name: m.link, exact: true }).click()
      await expect(page).toHaveURL(m.url)
      await expect(page.getByRole('heading', { name: m.heading })).toBeVisible()
      // Still authenticated inside the shell (sidebar present), not bounced to /login.
      await expect(page.locator('aside')).toBeVisible()
    })
  }

  // Quotes is HubSpot-backed; without a token its data fails to load, but routing
  // + the session gate are still verifiable (it must NOT bounce to /login).
  test('admin can open Quotes (routes to the requests queue)', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Quotes', exact: true }).click()
    await expect(page).toHaveURL(/\/quotes(\/requests)?$/)
    await expect(page).not.toHaveURL(/\/login$/)
  })
})
