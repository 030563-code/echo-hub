import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 4 — partial-delivery receipts (open until fully received → delivered),
// recurring-order templates, and the OO1/OO1-1 chain label. Buyer persona.
const s = sroState()

test.describe('SRO slice 4 — receiving, templates, numbering', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test.beforeEach(async ({ page }) => {
    await login(page, s!.buyer)
  })

  test('partial deliveries keep the PO open, then close it when fully received', async ({ page }) => {
    await page.goto('/purchase-orders')

    // Open the receive fixture's side panel.
    await page.getByText(s!.receivePo.po_number, { exact: true }).first().click()
    const panel = page.locator('aside, div').filter({ hasText: 'Line Items & Deliveries' }).first()
    await expect(page.getByText('Line Items & Deliveries')).toBeVisible()

    // Batch 1 — 5 of 10 H9.
    await page.getByRole('button', { name: 'Log delivery' }).first().click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('receive-EBH9NA').fill('5')
    await dialog.getByRole('button', { name: 'Log delivery' }).click()
    await expect(page.getByText('5/10 received')).toBeVisible()

    // Batch 2 — the remaining 5 H9 + 5 H10 → fully received → delivered.
    await page.getByRole('button', { name: 'Log delivery' }).first().click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('receive-EBH9NA').fill('5')
    await dialog.getByLabel('receive-EBH10NA').fill('5')
    await dialog.getByRole('button', { name: 'Log delivery' }).click()

    await expect(page.getByText('Fully received')).toBeVisible()
    // The "Log delivery" affordance is gone once delivered.
    await expect(page.getByRole('button', { name: 'Log delivery' })).toHaveCount(0)
    void panel
  })

  test('save a recurring-order template and reload it to pre-fill the form', async ({ page }) => {
    await page.goto('/purchase-orders/create')

    // Pick a real SKU + a recognisable note, then save as a template.
    const skuSelect = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: /EBH9NA/ }) })
    await skuSelect.selectOption('EBH9NA')
    await page.getByPlaceholder('Anything EB Group should know about this order…').fill('E2E note marker')

    page.once('dialog', (d) => d.accept('E2E Truck to Paris'))
    await page.getByRole('button', { name: 'Save as template' }).click()
    await expect(page.getByText(/Saved template/)).toBeVisible()

    // Reload + load the template → the note pre-fills.
    await page.goto('/purchase-orders/create')
    const tplSelect = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: 'Load from template…' }) })
    await tplSelect.selectOption({ label: 'E2E Truck to Paris' })
    await expect(page.getByPlaceholder('Anything EB Group should know about this order…')).toHaveValue('E2E note marker')
  })

  test('the side panel shows the PO number as the headline (no Ref line for a root order)', async ({ page }) => {
    await page.goto('/purchase-orders')
    // Under the 2026-07-14 display contract the Hub-minted placeholder is never
    // shown; the fixture's own E2E number is real (doesn't match ^PO-\d+$) so it
    // IS the headline. bomPo has no parent_po_id (raised directly, not via the
    // approval chain) so reference_po_number is null — no "Ref:" second line.
    await page.getByText(s!.bomPo.po_number, { exact: true }).first().click()
    // Scope to the slide-over panel itself (div.w-96 is unique to it on this
    // page) — a broad `hasText` filter also matches the ancestor that wraps both
    // the panel AND the still-visible board card behind it, which would make the
    // po-number text match twice (strict-mode violation).
    const panel = page.locator('div.w-96')
    await expect(panel.getByText(s!.bomPo.po_number, { exact: true })).toBeVisible()
    await expect(panel.getByText(/^Ref: /)).toHaveCount(0)
  })
})
