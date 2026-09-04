import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

/**
 * The invoice editor's attachments dropzone and its tracking state.
 *
 * READ-ONLY. The dropzone is exercised with drag events only: a real drop would
 * upload a file to Supabase Storage and insert a row, and no spec in this repo
 * writes. Uploading is covered by the manual pass instead.
 *
 * Needs an invoice that already exists, which E2E_DEAL_ID does not guarantee,
 * so it takes its own id and skips without it.
 */
const invoiceDealId = process.env.E2E_INVOICE_DEAL_ID
const c = anyCreds()

test.describe('Invoice editor panels', () => {
  test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')
  test.skip(!invoiceDealId, 'Set E2E_INVOICE_DEAL_ID to a deal that already has an invoice')

  test.beforeEach(async ({ page }) => {
    await login(page, c!)
    await page.goto(`/invoicing/${invoiceDealId}`)
  })

  test('the attachments dropzone renders and reacts to a drag', async ({ page }) => {
    const zone = page.getByTestId('attachment-dropzone')
    if ((await zone.count()) === 0) {
      test.skip(true, 'This persona cannot manage invoicing, so the dropzone is hidden')
    }
    await expect(zone).toContainText('Drag files here')
    // Internal-only is a decision, not a detail: say so on screen.
    await expect(page.getByText(/Not sent to the customer/i)).toBeVisible()

    await zone.dispatchEvent('dragenter')
    await expect(zone).toHaveClass(/border-echo-yellow/)
    await zone.dispatchEvent('dragleave')
    await expect(zone).not.toHaveClass(/border-echo-yellow/)
  })

  test('tracking is either offered or explained, never silently absent', async ({ page }) => {
    // The failure this guards: the whole Tracking column hides when Xero
    // returns nothing, and a failed lookup used to be logged to the console
    // only. The editor then looked exactly as it did before tracking was
    // built, so a broken n8n route was indistinguishable from a missing
    // feature. Exactly one of the three states must be on screen.
    const column = page.getByRole('columnheader', { name: 'Tracking' })
    const failed = page.getByText(/tracking categories could not be loaded/i)
    const empty = page.getByText(/no active tracking categories/i)

    await expect
      .poll(async () => (await column.count()) + (await failed.count()) + (await empty.count()), {
        message: 'the editor showed neither a Tracking column nor a reason for its absence',
      })
      .toBeGreaterThan(0)
  })
})
