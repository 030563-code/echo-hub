import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

/**
 * Will Call is askable at Quote Setup and confirmable at acceptance.
 *
 * Before this the flag existed only on the invoice, so every invoice opened
 * from the queue started delivered and a collected order had to be corrected by
 * hand at review, after the tax had already been calculated at the wrong place.
 *
 * READ-ONLY. It asserts the controls RENDER. It never clicks Start Quote,
 * never Publishes, and cancels out of the stage dialog rather than confirming,
 * because confirming would move a real deal and upsert deals_registry.
 */
const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN
const dealId = process.env.E2E_DEAL_ID
const c = anyCreds()

test.describe('Will Call', () => {
  test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, c!)
  })

  test('Quote Setup offers the collection tick', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed builder')
    test.skip(!dealId, 'Set E2E_DEAL_ID to a deal the persona can quote')

    await page.goto(`/quotes/create/${dealId}`)
    await expect(page.getByText('Quote Setup')).toBeVisible()
    // Sits with the depot, because it is the same decision: which depot, and
    // does the customer come to it. Hidden for a distributor quote, which is
    // why this asserts on the default (direct sale) state.
    await expect(page.getByRole('checkbox', { name: /Collected by the customer/i })).toBeVisible()
  })

  test('the acceptance dialog offers it too, and cancels cleanly', async ({ page }) => {
    test.skip(!hasToken, 'Set HUBSPOT_ACCESS_TOKEN to load the HubSpot-backed deal page')
    test.skip(!dealId, 'Set E2E_DEAL_ID to a deal the persona can open')

    await page.goto(`/quotes/deals/${dealId}`)
    const changeStage = page.getByRole('button', { name: /Change Stage/i })
    if ((await changeStage.count()) === 0) {
      test.skip(true, 'This persona cannot change the stage of this deal')
    }
    await changeStage.first().click()
    await expect(page.getByText(/Update Deal Stage/i)).toBeVisible()

    // The tick only shows in the US acceptance branch, which needs an accepted
    // stage and a US depot. Both are pipeline-dependent, so skip rather than
    // fail where they do not exist.
    const stageTrigger = page.getByRole('combobox').first()
    await stageTrigger.click()
    const accepted = page.getByRole('option', { name: /Quotation Accepted/i })
    if ((await accepted.count()) === 0) {
      await page.keyboard.press('Escape')
      test.skip(true, 'This pipeline has no Quotation Accepted stage')
    }
    await accepted.first().click()

    const depotTrigger = page.getByRole('combobox').filter({ hasText: /depot|Choose/i }).first()
    if ((await depotTrigger.count()) > 0) {
      await depotTrigger.click()
      const usDepot = page.getByRole('option', { name: /US-BAL|US-SBD/ })
      if ((await usDepot.count()) > 0) {
        await usDepot.first().click()
        await expect(page.getByRole('checkbox', { name: /Collected by the customer/i })).toBeVisible()
      }
    }

    // Leave without changing anything.
    await page.getByRole('button', { name: /^Cancel$/ }).click()
    await expect(page.getByText(/Update Deal Stage/i)).toBeHidden()
  })
})
