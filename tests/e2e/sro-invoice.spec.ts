import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO invoicing — generate per-container commercial invoices. Buyer persona holds
// invoice.create + cost.view. Fixture container E2EINV1 has EBH9NA × 10; the seeded
// transfer price is €27.01 → €270.10 (EUR leg). The USD leg applies the live
// rolling-13-week EUR_USD rate, so its amount is asserted loosely.
const s = sroState()

// Scope to the invoice-panel row (the container also appears on the shipment board).
function panelRow(page: import('@playwright/test').Page) {
  return page
    .getByRole('row')
    .filter({ hasText: 'E2EINV1' })
    .filter({ has: page.getByRole('button', { name: 'EUR' }) })
}

test.describe('SRO invoicing — commercial invoices', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test('EUR SRO→Group: numbered + valued from the transfer-price list', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/transport')

    await expect(page.getByRole('heading', { name: 'Commercial Invoices' })).toBeVisible()
    await panelRow(page).getByRole('button', { name: 'EUR' }).click()

    await expect(page.getByText(/EBGS\d{4}-\d{5}/).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('EBH9NA').first()).toBeVisible()
    await expect(page.getByText('€270.10').first()).toBeVisible()
  })

  test('USD Group→USA: converts via the live FX rate and shows the FX line', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/transport')

    await panelRow(page).getByRole('button', { name: 'USD' }).click()

    await expect(page.getByText(/EBGS\d{4}-\d{5}/).first()).toBeVisible({ timeout: 20000 })
    // FX line proves the EUR→USD conversion was applied + snapshotted.
    await expect(page.getByText(/EUR_USD @/).first()).toBeVisible()
    await expect(page.getByText(/\$\d/).first()).toBeVisible()
  })

  test('the /invoices list shows an issued invoice with its value (cost.view)', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/invoices')

    await expect(page.getByRole('heading', { name: 'Commercial Invoices' })).toBeVisible()
    await expect(page.getByText('EBGS-E2E-0001')).toBeVisible()
    await expect(page.getByText('€270.10').first()).toBeVisible()
  })

  test('a viewer with invoice.view but NOT cost.view sees the invoice with values stripped', async ({ page }) => {
    await login(page, s!.worker)
    await page.goto('/invoices')

    await expect(page.getByText('EBGS-E2E-0001')).toBeVisible()
    await expect(page.getByText(/Values hidden/)).toBeVisible()
    // The value is stripped SERVER-SIDE — it must not be in the payload at all.
    await expect(page.getByText('€270.10')).toHaveCount(0)
  })
})
