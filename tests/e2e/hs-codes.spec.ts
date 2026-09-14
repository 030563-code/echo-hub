import { test, expect, type Locator, type Page } from '@playwright/test'
import { adminCreds, login } from './helpers'

/**
 * HS codes, end to end: set one, see it survive a reload, put it back.
 *
 * Runs as the admin persona against the LIVE product_hs_codes table, so it
 * touches exactly one product on one leg (the first product, SRO to Group),
 * writes a clearly fake but valid code, and restores whatever was there before
 * in a finally block, pass or fail. A blank original is restored by clearing the
 * box, which deletes the row again.
 *
 * Every step inside the try has its own timeout, well inside the test's, so a
 * hung click still leaves the finally block time to put things back.
 */

const admin = adminCreds()

const STEP_MS = 15_000
const NAV_MS = 30_000
const LEG_LABEL = 'SRO to Group'

function firstRow(page: Page): Locator {
  return page.locator('tr[data-sku]').first()
}

function codeInput(row: Locator): Locator {
  return row.getByRole('textbox', { name: new RegExp(`^${LEG_LABEL} HS code for `) })
}

async function saveCode(page: Page, sku: string, value: string) {
  const row = page.locator(`tr[data-sku="${sku}"]`)
  const input = codeInput(row)
  await input.fill(value, { timeout: STEP_MS })
  const save = row.getByRole('button', { name: 'Save' })
  if (await save.isEnabled({ timeout: STEP_MS })) {
    await save.click({ timeout: STEP_MS })
    await expect(page.getByText(/HS codes saved for/).first()).toBeVisible({ timeout: STEP_MS })
  }
}

test.describe('HS codes screen', () => {
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD to run the HS codes path')

  test('a code saves, survives a reload, and is put back', async ({ page }) => {
    test.setTimeout(180_000)
    await login(page, admin!)
    await page.goto('/invoices/hs-codes', { timeout: NAV_MS })
    await expect(page.getByRole('heading', { name: 'HS codes' })).toBeVisible({ timeout: NAV_MS })
    await expect(page.getByRole('link', { name: 'Commercial invoices' })).toBeVisible()
    await expect(page.getByTestId('hs-codes-summary')).toBeVisible({ timeout: STEP_MS })

    const row = firstRow(page)
    await expect(row).toBeVisible({ timeout: STEP_MS })
    const sku = (await row.getAttribute('data-sku'))!
    const original = await codeInput(row).inputValue()
    const fake = original === '9999.99' ? '9999.98' : '9999.99'

    try {
      await saveCode(page, sku, fake)
      await page.reload({ timeout: NAV_MS })
      await expect(codeInput(page.locator(`tr[data-sku="${sku}"]`))).toHaveValue(fake, { timeout: NAV_MS })

      // An invalid code is refused on the screen before it reaches the server.
      const input = codeInput(page.locator(`tr[data-sku="${sku}"]`))
      await input.fill('3926..90', { timeout: STEP_MS })
      await expect(page.locator(`tr[data-sku="${sku}"]`).getByRole('button', { name: 'Save' })).toBeDisabled({ timeout: STEP_MS })
      await input.fill(fake, { timeout: STEP_MS })
    } finally {
      await page.goto('/invoices/hs-codes', { timeout: NAV_MS })
      await saveCode(page, sku, original)
      await page.reload({ timeout: NAV_MS })
      await expect(codeInput(page.locator(`tr[data-sku="${sku}"]`))).toHaveValue(original, { timeout: NAV_MS })
    }
  })
})
