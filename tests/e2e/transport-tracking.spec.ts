import { test, expect } from '@playwright/test'
import { daveCreds, login } from './helpers'

/**
 * Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?"
 *
 * Runs as Dave against a local server. The reference test cleans up after itself. Adding a SPOT
 * ID asks Cargo Partner the same two read-only questions the sync does; nothing is sent to them.
 */

test.describe('Transport, adding by hand, as Dave', () => {
  const dave = daveCreds()
  test.skip(!dave, 'Set DAVE_EMAIL/DAVE_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, dave!)
  })

  test('a reference typed on a shipment is shown, found by the search, and can be removed', async ({ page }) => {
    const reference = `E2E-${Date.now()}`
    await page.goto('/transport/244498887')
    await page.getByLabel('Add a reference').fill(reference)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('listitem').filter({ hasText: reference })).toBeVisible({ timeout: 15_000 })

    await page.goto('/transport')
    await page.getByPlaceholder('SPOT ID, container or reference').fill(reference.toLowerCase())
    await expect(page.getByRole('link').filter({ hasText: 'SPOT 244498887' })).toBeVisible()

    await page.goto('/transport/244498887')
    await page.getByRole('button', { name: `Remove ${reference}` }).click()
    await expect(page.getByRole('listitem').filter({ hasText: reference })).toHaveCount(0, { timeout: 15_000 })
  })

  test('a SPOT ID Cargo Partner does not know is refused in words', async ({ page }) => {
    await page.goto('/transport')
    await page.getByRole('button', { name: 'Add a shipment' }).click()
    // The eight digit ID from the shipping sheet, which Cargo Partner has never known.
    await page.getByLabel('SPOT ID or order reference').fill('24188833')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Cargo Partner has no shipment with the SPOT ID or reference 24188833.')).toBeVisible({
      timeout: 30_000,
    })
  })
})
