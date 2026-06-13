import { test, expect } from '@playwright/test'
import { login, adminCreds, canSeeMrp } from './helpers'

// Positive RBAC path — requires the PRIVILEGED persona (super-admin sees all
// modules). Configure via E2E_USERNAME / E2E_PASSWORD. Self-skips if that persona
// isn't configured, or if the configured user turns out not to be privileged.
const admin = adminCreds()

test.describe('Navigation + RBAC (privileged user)', () => {
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD (a super-admin) to run the positive path')

  test.beforeEach(async ({ page }) => {
    await login(page, admin!)
    test.skip(!(await canSeeMrp(page)), 'E2E_USERNAME is not privileged (no MRP) — provide a super-admin')
  })

  test('sidebar shows every workstream — and no Weeklies', async ({ page }) => {
    const nav = page.locator('aside')
    for (const label of ['Dashboard', 'Quotes', 'Purchase Orders', 'Bill of Materials', 'Transport', 'MRP']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
    await expect(nav.getByRole('link', { name: 'Weeklies', exact: true })).toHaveCount(0)
  })

  test('dashboard lists the accessible module cards', async ({ page }) => {
    await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'MRP' })).toBeVisible()
  })

  const opsModules = [
    { link: 'MRP', url: /\/mrp$/, heading: 'MRP Prediction Dashboard' },
    { link: 'Transport', url: /\/transport$/, heading: 'Logistics & Shipping' },
    { link: 'Purchase Orders', url: /\/purchase-orders$/, heading: 'Supplier & PO Tracker' },
    { link: 'Bill of Materials', url: /\/bom$/, heading: 'Bill of Materials & Pricing' },
  ]
  for (const m of opsModules) {
    test(`admin can open ${m.link}`, async ({ page }) => {
      await page.locator('aside').getByRole('link', { name: m.link, exact: true }).click()
      await expect(page).toHaveURL(m.url)
      await expect(page.getByRole('heading', { name: m.heading })).toBeVisible()
      await expect(page.locator('aside')).toBeVisible()
    })
  }

  test('admin can open Quotes (routes to the requests queue)', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Quotes', exact: true }).click()
    await expect(page).toHaveURL(/\/quotes(\/requests)?$/)
    await expect(page).not.toHaveURL(/\/login$/)
  })
})
