import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 3 — cost.view gates every EUR figure (server-side). Buyer (cost.view)
// sees prices + the priced "Bamida PO"; worker (no cost.view) sees the price-less
// "BOM PO" and no BOM Prices tab.
const s = sroState()

test.describe('SRO slice 3 — price visibility', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test('buyer WITH cost.view sees prices + the priced Bamida PO', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/bom')

    // BOM Prices tab is visible to cost.view holders.
    await expect(page.getByRole('button', { name: 'BOM Prices' })).toBeVisible()

    // The priced Bamida PO document shows totals.
    await page.getByRole('button', { name: 'Bamida PO' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/Total incl\. tax/)).toBeVisible()
    await expect(dialog.getByText(/€/).first()).toBeVisible()
  })

  test('worker WITHOUT cost.view gets the price-less BOM PO + no BOM Prices tab', async ({ page }) => {
    await login(page, s!.worker)
    await page.goto('/bom')

    // BOM Prices tab is hidden (it is a pricing view).
    await expect(page.getByRole('button', { name: 'BOM Prices' })).toHaveCount(0)

    // The document is the price-less "BOM PO" — no priced "Bamida PO" button.
    await expect(page.getByRole('button', { name: 'Bamida PO' })).toHaveCount(0)
    await page.getByRole('button', { name: 'BOM PO' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/Prices hidden/)).toBeVisible()
    await expect(dialog.getByText(/Total incl\. tax/)).toHaveCount(0)
  })
})
