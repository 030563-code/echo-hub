import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// BOM material-price master — edit ONE material price and see it ripple to every
// product that uses it (the Δ-vs-sheet view). Buyer persona holds bom.edit +
// cost.view. ACI-T40 (seeded €7.16, used in ~17 products). The teardown restores
// material_prices to the snapshot baseline, so this edit is undone.
const s = sroState()

test.describe('BOM — material-price master', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test('editing a material price ripples to products and shows on BOM Prices', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/bom')

    // Materials tab (cost.view) → edit ACI-T40 (7.16 → 12.16).
    await page.getByRole('button', { name: /^Materials/ }).click()
    const input = page.getByLabel('price-ACI-T40')
    await expect(input).toBeVisible({ timeout: 15000 })
    await input.fill('12.16')
    // Saving now asks for confirmation (guards a fat-finger reprice) — accept it.
    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: 'Save material prices' }).click()
    await expect(page.getByText(/Updated \d+ material price/)).toBeVisible({ timeout: 15000 })

    // BOM Prices tab → a non-zero positive Δ appears (products using ACI-T40 went up).
    await page.getByRole('button', { name: 'BOM Prices' }).click()
    await expect(page.getByText(/\+\d+\.\d{2}/).first()).toBeVisible({ timeout: 10000 })
  })

  test('an approved SRO order shows its cost FROZEN at approval (authoritative, not re-exploded)', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/bom')
    // The SRO Orders tab (default) lists approved SRO POs. The frozen fixture's SRO
    // cost is €4,242.42 — a value a live explosion could never produce — so seeing it
    // proves loadSroPoBoms returned the frozen snapshot, not a re-explosion.
    await expect(page.getByText('🔒 frozen').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/4,242\.42/).first()).toBeVisible()
  })
})
