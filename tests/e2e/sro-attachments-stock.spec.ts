import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 5 — PO file attachments (upload/list/delete) + the non-blocking
// stock-shortfall warning on the raise form. Buyer persona (po.create + cost.view).
const s = sroState()

test.describe('SRO slice 5 — attachments + stock alert', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test.beforeEach(async ({ page }) => {
    await login(page, s!.buyer)
  })

  test('attach a file to a PO, see it listed, then delete it', async ({ page }) => {
    await page.goto('/purchase-orders')
    await page.getByText(s!.receivePo.po_number, { exact: true }).first().click()
    await expect(page.getByText('Attachments')).toBeVisible()
    await expect(page.getByText('No files attached.')).toBeVisible()

    // Upload via the hidden file input (no temp file — pass a buffer).
    await page.locator('input[type=file]').setInputFiles({
      name: 'e2e-test.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e test attachment'),
    })
    await expect(page.getByText('e2e-test.pdf')).toBeVisible()

    // Delete it (confirm dialog) → back to empty.
    page.once('dialog', (d) => d.accept())
    await page.getByTitle('Delete').click()
    await expect(page.getByText('e2e-test.pdf')).toHaveCount(0)
    await expect(page.getByText('No files attached.')).toBeVisible()
  })

  test('raise form flags a stock shortfall without blocking', async ({ page }) => {
    await page.goto('/purchase-orders/create')
    const skuSelect = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: /EBH9NA/ }) })
    await skuSelect.selectOption('EBH9NA')
    await page.getByLabel('Quantity').first().fill('999999')
    // Non-blocking warning appears; the submit button stays enabled.
    await expect(page.getByText(/Stock short/)).toBeVisible()
    // Non-blocking: the submit button stays enabled despite the shortfall.
    await expect(page.getByRole('button', { name: 'Raise PO for approval' })).toBeEnabled()
  })
})
