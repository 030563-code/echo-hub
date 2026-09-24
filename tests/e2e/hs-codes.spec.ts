import { test, expect, type Locator, type Page } from '@playwright/test'
import { adminCreds, limitedCreds, login } from './helpers'

/**
 * HS codes screen, end to end, WITHOUT writing a single code.
 *
 * The earlier version saved a format-valid fake code into the LIVE
 * product_hs_codes table and restored the original afterwards. A code that
 * passes the format gate is a code that prints on a customs invoice, so one
 * failed restore would have left a fake on real paperwork. This spec never
 * clicks Save. The save round trip is covered by tests/unit/save-hs-codes.test.ts
 * against a mocked admin client.
 *
 * What it does type goes into one box and is put back before the test ends, so
 * the row is exactly as it was and the persona's unsaved-codes draft, if it had
 * one, is left as it was too. If the box cannot be put back, the test fails
 * naming the SKU and the value.
 */

const admin = adminCreds()
const limited = limitedCreds()

const STEP_MS = 15_000
const NAV_MS = 30_000
const LEG_LABEL = 'SRO to Group'
const FORMAT_ERROR = /an HS code is 6 to 10 digits/

function rowFor(page: Page, sku: string): Locator {
  return page.locator(`tr[data-sku="${sku}"]`)
}

function codeInput(row: Locator): Locator {
  // A combobox, not a textbox: each box offers the codes in use (a datalist) as it is typed in.
  return row.getByRole('combobox', { name: new RegExp(`^${LEG_LABEL} HS code for `) })
}

/**
 * Put the box back to `original` and prove it, or fail saying what could not be
 * restored. `wasUnsaved` is whether the row already carried unsaved typing
 * before the test touched it, so a persona's own draft is neither lost nor
 * mistaken for a failed restore.
 */
async function restoreBox(page: Page, sku: string, original: string, wasUnsaved: boolean) {
  const row = rowFor(page, sku)
  const input = codeInput(row)
  await expect(async () => {
    await input.fill(original, { timeout: STEP_MS })
    await expect(input).toHaveValue(original, { timeout: 2_000 })
    await expect(row.getByTestId('hs-codes-row-unsaved')).toHaveCount(wasUnsaved ? 1 : 0, { timeout: 2_000 })
  }, `could not restore the ${LEG_LABEL} box for ${sku} to "${original}"`).toPass({ timeout: STEP_MS * 2 })
}

test.describe('HS codes screen', () => {
  test('renders the products and the summary, and checks a code without saving it', async ({ page }) => {
    test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD to run the HS codes path')
    test.setTimeout(180_000)
    await login(page, admin!)
    await page.goto('/invoices/hs-codes', { timeout: NAV_MS })
    await expect(page.getByRole('heading', { name: 'HS codes' })).toBeVisible({ timeout: NAV_MS })
    await expect(page.getByRole('link', { name: 'Commercial invoices' })).toBeVisible()
    await expect(page.getByTestId('hs-codes-summary')).toBeVisible({ timeout: STEP_MS })
    // The codes in use (po_hs_codes) are offered in every box.
    await expect(page.locator('datalist#hs-codes-in-use option')).not.toHaveCount(0, { timeout: STEP_MS })

    const firstRow = page.locator('tr[data-sku]').first()
    await expect(firstRow).toBeVisible({ timeout: STEP_MS })
    expect(await page.locator('tr[data-sku]').count()).toBeGreaterThan(0)

    const sku = (await firstRow.getAttribute('data-sku'))!
    const row = rowFor(page, sku)
    const input = codeInput(row)
    const save = row.getByRole('button', { name: 'Save' })

    // Read the box first and decide from what is really there, once the page has
    // finished reading any unsaved-codes draft (it can change what the box holds).
    await expect(input).toBeVisible({ timeout: STEP_MS })
    await page.waitForLoadState('networkidle', { timeout: NAV_MS })
    const original = await input.inputValue()
    const wasUnsaved = (await row.getByTestId('hs-codes-row-unsaved').count()) > 0
    const valid = original.trim() === '3926.90' ? '3926.91' : '3926.90'

    try {
      // An invalid code: no error while typing, the error after blur, and Save stays disabled.
      await input.fill('12AB', { timeout: STEP_MS })
      await expect(row.getByText(FORMAT_ERROR)).toHaveCount(0)
      await expect(save).toBeDisabled({ timeout: STEP_MS })
      await input.blur()
      await expect(row.getByText(FORMAT_ERROR)).toBeVisible({ timeout: STEP_MS })
      await expect(save).toBeDisabled()

      // A valid code enables Save. It is never clicked.
      await input.fill(valid, { timeout: STEP_MS })
      await expect(row.getByText(FORMAT_ERROR)).toHaveCount(0, { timeout: STEP_MS })
      await expect(save).toBeEnabled({ timeout: STEP_MS })
      await expect(row.getByTestId('hs-codes-row-unsaved')).toBeVisible({ timeout: STEP_MS })
      await expect(page.getByTestId('hs-codes-unsaved')).toBeVisible({ timeout: STEP_MS })
    } finally {
      await restoreBox(page, sku, original, wasUnsaved)
      // Leave by the tab bar, a soft navigation, so the page flushes its draft
      // as it now stands and nothing this test typed is left behind.
      await page.getByRole('link', { name: 'Commercial invoices' }).click({ timeout: STEP_MS })
      await expect(page.getByRole('heading', { name: 'Commercial Invoices' })).toBeVisible({ timeout: NAV_MS })
    }
  })

  test('a limited persona sees no code inputs, or is refused the screen', async ({ page }) => {
    test.skip(!limited, 'Set E2E_LIMITED_USERNAME/E2E_LIMITED_PASSWORD to run the limited persona path')
    await login(page, limited!)
    await page.goto('/invoices/hs-codes', { timeout: NAV_MS })
    const heading = page.getByRole('heading', { name: 'HS codes' })
    // requireCapability('invoice.view') sends a persona without it to the dashboard.
    const refused = page.getByText('Welcome to the Echo Barrier Hub')
    await expect(heading.or(refused).first()).toBeVisible({ timeout: NAV_MS })
    if (await heading.isVisible()) {
      await expect(page.getByTestId('hs-codes-summary').or(page.getByText(/nothing to code|Could not load/)).first()).toBeVisible({
        timeout: STEP_MS,
      })
      await expect(page.locator('tr[data-sku] input')).toHaveCount(0)
      await expect(page.locator('tr[data-sku]').getByRole('button', { name: 'Save' })).toHaveCount(0)
    } else {
      expect(new URL(page.url()).pathname).toBe('/')
    }
  })
})
