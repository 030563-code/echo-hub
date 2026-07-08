import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 2 — real catalog picklist on the raise form + the Bamida supplier
// resolved from po_suppliers. Needs the buyer persona + fixtures (run _setup.mjs).
const s = sroState()

test.describe('SRO slice 2 — catalog + suppliers', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first (writes tests/e2e/.e2e-state.json)')

  test.beforeEach(async ({ page }) => {
    await login(page, s!.buyer)
  })

  test('raise form SKU picklist is seeded from po_product_catalog', async ({ page }) => {
    await page.goto('/purchase-orders/create')
    // The line-item SKU <select> is the one carrying real catalogue options.
    await expect(page.getByRole('option', { name: /Echo Barrier H9/ }).first()).toBeAttached()
    await expect(page.getByRole('option', { name: /Echo Barrier H10/ }).first()).toBeAttached()
  })

  test('Bamida PO resolves its supplier from po_suppliers (BAMIDA, s.r.o.)', async ({ page }) => {
    await page.goto('/bom')
    // Open the SRO-order BOM fixture and its Bamida PO document.
    await expect(page.getByText(s!.bomPo.po_number).first()).toBeVisible()
    await page.getByRole('button', { name: 'Bamida PO' }).first().click()
    const dialog = page.getByRole('dialog')
    // The supplier block resolves to the po_suppliers row (name shown on-screen;
    // full address is rendered into the PDF). Name proves the wiring.
    await expect(dialog.getByText('BAMIDA, s.r.o.')).toBeVisible()
  })
})
