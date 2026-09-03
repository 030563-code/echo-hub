import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

/**
 * The quantity box can be cleared and retyped.
 *
 * The bug this guards: the cart held quantity as a NUMBER in a
 * `type="number"` input. React updates such an input only when
 * `node.value != value`, and "0200" != 200 is false, so React left the DOM
 * alone and the field stayed showing 0200 for good. Clearing it produced `|| 0`
 * and re-rendered a 0 that could not be deleted or typed in front of.
 *
 * READ-ONLY, like every spec here. It completes the setup dialog, which is
 * client state only (handleSetupComplete just closes it), and NEVER clicks
 * Publish, which is what writes to HubSpot and deals_registry.
 */
const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN
const dealId = process.env.E2E_DEAL_ID
const c = anyCreds()

test.describe('Quote builder numeric inputs', () => {
  test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')

  test('the quantity box accepts 200 rather than 0200', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed builder')
    test.skip(!dealId, 'Set E2E_DEAL_ID to a deal the persona can quote')

    await login(page, c!)
    await page.goto(`/quotes/create/${dealId}`)
    await expect(page.getByText('Quote Setup')).toBeVisible()

    // Template and probability are the only two required fields. Choosing them
    // and continuing writes nothing.
    await page.getByRole('combobox').filter({ hasText: /Template/i }).first().click()
    await page.getByRole('option').first().click()
    await page.getByRole('combobox').filter({ hasText: /probability/i }).first().click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: /Start Quote/i }).click()

    const qty = page.getByRole('textbox', { name: 'Quantity' }).first()
    if ((await qty.count()) === 0) {
      test.skip(true, 'This deal has no line items to type into')
    }

    // Typing over a selection gives exactly what was typed.
    await qty.click()
    await page.keyboard.press('ControlOrMeta+A')
    await qty.pressSequentially('200')
    await expect(qty).toHaveValue('200')

    // The box can be emptied, which the old one could not.
    await qty.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await expect(qty).toHaveValue('')

    // Blur restores 1 rather than leaving a line with no quantity.
    await qty.blur()
    await expect(qty).toHaveValue('1')

    // And a stray leading zero is tidied on the way out.
    await qty.click()
    await page.keyboard.press('ControlOrMeta+A')
    await qty.pressSequentially('0200')
    await qty.blur()
    await expect(qty).toHaveValue('200')
  })
})
