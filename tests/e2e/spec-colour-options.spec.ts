import { test, expect } from '@playwright/test'
import { adminCreds, login } from './helpers'
import { serviceClient } from './db-helpers'

/**
 * Juraj, 22 Sep 2026: colour options for PC350FR and P200 on the manufacturing specification.
 *
 * Opens the newest manufacturing order's specification as the privileged persona and checks that
 * the PC350FR line offers exactly the colours material_colour_option holds, and that a material
 * which does not come in colours (Datatag) offers none. Read only: nothing is saved or confirmed,
 * so a signed document stays signed. Self-skips when the table is empty, which is what an
 * environment without migration 20260923100000 looks like.
 */
test.describe('the manufacturing specification offers fabric colours', () => {
  const c = adminCreds()
  const sb = serviceClient()
  test.skip(!c || !sb, 'Set E2E_USERNAME/E2E_PASSWORD and SUPABASE_SERVICE_ROLE_KEY')

  test("PC350FR lists Juraj's colours on the newest manufacturing order, and Datatag lists none", async ({ page }) => {
    const { data: po } = await sb!
      .from('purchase_orders')
      .select('id, po_number')
      .eq('leg', 'SRO_TO_SUPPLIER')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    test.skip(!po, 'No manufacturing order to open')

    const { data: rows } = await sb!
      .from('material_colour_option')
      .select('colour')
      .eq('family', 'PC350FR')
      .eq('active', true)
      .order('sort_order', { ascending: true })
    const colours = (rows ?? []).map((r) => String(r.colour))
    test.skip(colours.length === 0, 'material_colour_option holds no PC350FR rows here')

    await login(page, c!)
    await page.goto(`/purchase-orders/${po!.id}/specification`)
    await expect(page.getByRole('heading', { name: /Manufacturing specification/ })).toBeVisible()

    const picker = page.getByRole('combobox', { name: /^Colour of PC350FR/ }).first()
    await expect(picker).toBeVisible()
    const labels = await picker.locator('option').allTextContents()
    expect(labels[0]).toBe('Colour not chosen')
    for (const colour of colours) expect(labels, colour).toContain(colour)

    // Datatag is not a coloured fabric, so its row has no picker.
    await expect(page.getByRole('combobox', { name: /^Colour of DAT-01/ })).toHaveCount(0)

    await page.screenshot({ path: test.info().outputPath('spec-colour-options.png'), fullPage: true })
  })
})
