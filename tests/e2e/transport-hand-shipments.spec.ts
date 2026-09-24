import { test, expect } from '@playwright/test'
import { daveCreds, login } from './helpers'

/**
 * Dean, 24 Sep 2026: a shipment not booked with Cargo Partner is kept by hand in the Hub, with every
 * field editable and what is on it listed, instead of only in Dave's sheet.
 *
 * Runs as Dave against a local server and deletes the shipment it made. Invented container and
 * order numbers: the repository is public.
 */

test.describe('Transport, a shipment kept by hand, as Dave', () => {
  const dave = daveCreds()
  test.skip(!dave, 'Set DAVE_EMAIL/DAVE_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, dave!)
  })

  test('is added for a depot, filled in, listed on the board, and deleted', async ({ page }) => {
    const order = `E2E-${Date.now()}`
    page.on('dialog', (d) => d.accept())

    await page.goto('/transport')
    await page.getByRole('button', { name: 'Add a shipment' }).click()
    await page.getByRole('button', { name: 'Not booked yet? Keep it by hand' }).click()
    // The switch alone must not add anything: the depot is chosen first.
    await expect(page.getByRole('button', { name: 'Keep it by hand', exact: true })).toBeEnabled()
    await expect(page).toHaveURL(/\/transport$/)
    await page.getByLabel('Going to').selectOption('US-BAL')
    await page.getByRole('button', { name: 'Keep it by hand', exact: true }).click()
    await page.waitForURL(/\/transport\/[0-9a-f-]{36}$/)
    const shipmentUrl = page.url()

    await page.getByPlaceholder('ABCU1234567, separated by commas').fill('zzzu 0000017')
    await page.getByLabel('Collected').fill('2026-09-20')
    await page.getByLabel('Due at the depot').fill('2026-10-30')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'ZZZU0000017' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Collected from the factory')).toBeVisible()

    await page.getByRole('button', { name: 'Add what is on it' }).click()
    await page.getByLabel('Line 1 product').fill('H9BALT')
    await page.getByLabel('Line 1 quantity').fill('140')
    // 70 barriers a pallet, filled in when a barrier is chosen.
    await expect(page.getByLabel('Line 1 pallets')).toHaveValue('2')
    await page.getByLabel('Line 1 USA / Canada order').fill(order)
    await page.getByRole('button', { name: 'Save contents' }).click()
    await expect(page.getByText('140 × H9BALT on 2 pallets').first()).toBeVisible({ timeout: 15_000 })

    await page.goto('/transport')
    await page.getByPlaceholder('SPOT ID, container or reference').fill(order)
    const row = page.getByRole('link').filter({ hasText: order })
    await expect(row.getByText('Kept by hand')).toBeVisible()
    await expect(row.getByText('140 × H9BALT on 2 pallets')).toBeVisible()

    await page.goto(shipmentUrl)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForURL(/\/transport$/)
    await page.getByPlaceholder('SPOT ID, container or reference').fill(order)
    await expect(page.getByRole('link').filter({ hasText: order })).toHaveCount(0)
  })

  test('a container number that is not one is refused by name', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await page.goto('/transport')
    await page.getByRole('button', { name: 'Add a shipment' }).click()
    await page.getByRole('button', { name: 'Not booked yet? Keep it by hand' }).click()
    await page.getByRole('button', { name: 'Keep it by hand', exact: true }).click()
    await page.waitForURL(/\/transport\/[0-9a-f-]{36}$/)

    await page.getByPlaceholder('ABCU1234567, separated by commas').fill('ZZZU0000017, nope')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('nope is not a container number')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForURL(/\/transport$/)
  })
})
