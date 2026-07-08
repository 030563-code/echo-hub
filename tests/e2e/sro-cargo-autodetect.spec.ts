import { test, expect } from '@playwright/test'
import { login } from './helpers'
import { sroState } from './sro-helpers'

// SRO slice 6 (auto-detect + persist) — from the PO board a transport.view user
// detects a PO's Cargo Partner SPOT ID + shipment FROM the PO number, the system
// stores it, and it survives a reload (proving DB persistence, not just in-memory).
// LIVE: hits the real Cargo Partner API for the fixture PO forced to PO-00001364
// → SPOT 240362822. May flake if that shipment is archived / the API is down.
const s = sroState()

test.describe('SRO slice 6 — PO→shipment auto-detect + persistence', () => {
  test.skip(!s, 'Run `node tests/e2e/_setup.mjs` first')

  test('detects + stores the SPOT ID from the PO number, and it persists', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/purchase-orders')

    // The Sync-shipments sweep is gated on transport.view (the buyer has it).
    await expect(page.getByRole('button', { name: 'Sync shipments' })).toBeVisible()

    // Open the Cargo fixture PO (po_number forced to a real Cargo reference).
    await page.getByText(s!.cargoPo.po_number, { exact: true }).first().click()
    await expect(page.getByText('Shipment (Cargo Partner)')).toBeVisible()
    await expect(page.getByText('No shipment linked yet.')).toBeVisible()

    // Detect → resolves the REAL SPOT ID from the PO number (no manual typing).
    await page.getByRole('button', { name: 'Detect shipment' }).click()
    await expect(page.getByText('240362822').first()).toBeVisible({ timeout: 30000 })

    // Persistence: reload (client state is lost), re-open — the stored SPOT ID is
    // re-loaded from po_shipments, proving it was written to the database.
    await page.reload()
    await page.getByText(s!.cargoPo.po_number, { exact: true }).first().click()
    await expect(page.getByText('240362822').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Refresh shipment' })).toBeVisible()
  })

  // The durable case: a real Hub PO number is NOT a Cargo reference (Cargo 404s
  // it), so the system must show NO SPOT ID — gracefully, not as an error.
  test('a Hub PO with no Cargo shipment shows no SPOT ID (graceful)', async ({ page }) => {
    await login(page, s!.buyer)
    await page.goto('/purchase-orders')

    await page.getByText(s!.bomPo.po_number, { exact: true }).first().click()
    await expect(page.getByText('Shipment (Cargo Partner)')).toBeVisible()

    await page.getByRole('button', { name: 'Detect shipment' }).click()
    await expect(page.getByText('No Cargo Partner shipment found for this PO number yet.')).toBeVisible({ timeout: 30000 })
    // No SPOT ID block, and no scary error text.
    await expect(page.getByText('SPOT ID')).toHaveCount(0)
    await expect(page.getByText(/Couldn't reach Cargo Partner/)).toHaveCount(0)
  })
})
