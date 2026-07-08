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

  test('the chain label shows the SRO order as the base number (SRO-rooted)', async ({ page }) => {
    await page.goto('/purchase-orders')
    // SRO-rooted numbering: the SRO order (EB_GROUP_TO_SRO) is the base PO-001; its
    // Bamida/Cargo children are base-1/base-2. So the SRO order itself reads as base.
    const base = (s!.bomPo.master_ref ?? s!.bomPo.po_number).replace(/^MR-/, '')
    await expect(page.getByText(base, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`${base}-1`, { exact: true })).toHaveCount(0)
  })
})
