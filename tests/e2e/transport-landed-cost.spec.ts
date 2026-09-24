import { test, expect } from '@playwright/test'
import { daveCreds, login } from './helpers'

/**
 * Dean, 24 Sep 2026: Dave types Group's commercial invoices and, while Nippon's bill is on its way,
 * the customs costs, and the Hub works out the cost per barrier the way his tab does.
 *
 * Runs as Dave against a local server on a shipment it makes and deletes. Invented figures: the
 * repository is public. Worked by hand: 280 H10HERCB at EUR 100 and 280 H9BALT at EUR 80, each on
 * its own invoice at 1 USD = 0.8 EUR with EUR 400 palletising, EUR 2,000 delivery and EUR 80
 * insurance; then 3,339 duty, 218.23 MPF and 78.75 HMF by value, 109.08 disbursement with them,
 * 335 clearance and 300 container delivery by pallets. That lands the HERC at 144.6244 a barrier
 * and the H9 at 118.1615.
 */

test.describe('Transport, the landed cost, as Dave', () => {
  const dave = daveCreds()
  test.skip(!dave, 'Set DAVE_EMAIL/DAVE_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, dave!)
  })

  test('is worked per product from the invoices and the typed customs, and deleted with the shipment', async ({ page }) => {
    page.on('dialog', (d) => d.accept())

    await page.goto('/transport')
    await page.getByRole('button', { name: 'Add a shipment' }).click()
    await page.getByRole('button', { name: 'Not booked yet? Keep it by hand' }).click()
    await page.getByLabel('Going to').selectOption('US-BAL')
    await page.getByRole('button', { name: 'Keep it by hand', exact: true }).click()
    await page.waitForURL(/\/transport\/[0-9a-f-]{36}$/)

    await page.getByRole('button', { name: 'Add what is on it' }).click()
    await page.getByLabel('Line 1 product').fill('H10HERCB')
    await page.getByLabel('Line 1 quantity').fill('280')
    await page.getByRole('button', { name: 'Add a line' }).click()
    await page.getByLabel('Line 2 product').fill('H9BALT')
    await page.getByLabel('Line 2 quantity').fill('280')
    await expect(page.getByLabel('Line 2 pallets')).toHaveValue('4')
    await page.getByRole('button', { name: 'Save contents' }).click()
    await expect(page.getByText('280 × H10HERCB, 280 × H9BALT on 8 pallets').first()).toBeVisible({ timeout: 15_000 })

    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Landed cost' }) })
    await expect(card.getByText('Waiting for figures')).toBeVisible()

    await card.getByRole('button', { name: 'Add a commercial invoice' }).click()
    await card.getByLabel('Invoice 1 number').fill('TEST-INV-1')
    await card.getByLabel('Invoice 1 currency').selectOption('EUR')
    await card.getByLabel('Invoice 1 rate').fill('0.8')
    await card.getByLabel('Invoice 1 palletising').fill('400')
    await card.getByLabel('Invoice 1 delivery').fill('2000')
    await card.getByLabel('Invoice 1 insurance').fill('80')
    await card.getByRole('button', { name: 'Another invoice' }).click()
    await card.getByLabel('Invoice 2 number').fill('TEST-INV-2')
    await card.getByLabel('Invoice 2 currency').selectOption('EUR')
    await card.getByLabel('Invoice 2 rate').fill('0.8')
    await card.getByLabel('Invoice 2 palletising').fill('400')
    await card.getByLabel('Invoice 2 delivery').fill('2000')
    await card.getByLabel('Invoice 2 insurance').fill('80')
    await card.getByLabel('H10HERCB invoice').selectOption({ label: 'TEST-INV-1' })
    await card.getByLabel('H10HERCB amount').fill('28000')
    await card.getByLabel('H9BALT invoice').selectOption({ label: 'TEST-INV-2' })
    await card.getByLabel('H9BALT amount').fill('22400')
    await card.getByRole('button', { name: 'Save invoices' }).click()
    await expect(card.getByText('No customs costs yet')).toBeVisible({ timeout: 15_000 })

    await card.getByRole('button', { name: 'Edit the customs and delivery costs' }).click()
    await card.getByLabel('Duty', { exact: true }).fill('3339')
    await card.getByLabel('Processing fee (MPF)').fill('218.23')
    await card.getByLabel('Harbour fee (HMF)').fill('78.75')
    await card.getByLabel('Duty disbursement').fill('109.08')
    await card.getByLabel('Clearance charges').fill('335')
    await card.getByLabel('Container delivery').fill('300')
    await card.getByRole('button', { name: 'Save costs' }).click()

    await expect(card.getByText('Draft: customs typed by hand')).toBeVisible({ timeout: 15_000 })
    const perBarrier = card.getByRole('row').filter({ hasText: 'Cost per barrier' })
    await expect(perBarrier).toContainText('144.6244')
    await expect(perBarrier).toContainText('118.1615')
    await expect(card.getByRole('row').filter({ hasText: /^Total/ })).toContainText('73,580.06')

    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForURL(/\/transport$/)
  })
})
