import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 6 — Cargo Partner SPOT-ID auto-retrieve by PO number. This is a LIVE
// integration test: it hits the real Cargo Partner API for a known Echo Barrier
// shipment (PO-00001364 → SPOT 240362822). It may flake if that shipment is later
// archived or the API is unreachable — that's expected for an external dependency.
const s = sroState()

test.describe('SRO slice 6 — Cargo Partner SPOT-ID auto-retrieve', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test('a PO number auto-retrieves the real SPOT ID (no manual entry)', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/transport')
    await page.getByRole('button', { name: 'Add Shipment' }).click()

    await page.getByLabel('PO number').fill('PO-00001364')
    await page.getByRole('button', { name: 'Retrieve' }).click()

    // The SPOT ID field is auto-filled with the REAL Cargo Partner id (240362822),
    // not the PO number that was typed.
    await expect(page.getByLabel('SPOT ID')).toHaveValue('240362822', { timeout: 25000 })
    await expect(page.getByText('240362822').first()).toBeVisible()
  })
})
