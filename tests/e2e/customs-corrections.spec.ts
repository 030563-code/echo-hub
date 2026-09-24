import { test, expect } from '@playwright/test'
import { daveCreds, login } from './helpers'

/**
 * Dean, 24 Sep 2026: "Some of the things say need a look but theres no way to edit in the Hub."
 *
 * Runs as Dave against a local server on the real bills, so it leaves nothing behind: the sign-off
 * is undone in the same test, and the reading editor is only typed into, never saved.
 */

type Page = import('@playwright/test').Page

async function needALook(page: Page): Promise<number> {
  await page.goto('/transport/customs')
  const tile = page.locator('div.rounded-lg').filter({ has: page.getByText('Need a look', { exact: true }) })
  return Number((await tile.locator('p').last().innerText()).replace(/\D+/g, ''))
}

/** A bill the checks flag, found on the list rather than named here: the repository is public. */
async function aFlaggedBill(page: Page): Promise<string> {
  await page.goto('/transport/customs')
  const row = page.getByRole('row').filter({ hasText: 'Needs a look' }).first()
  const href = await row.getByRole('link', { name: 'Open' }).getAttribute('href')
  expect(href).toMatch(/^\/transport\/customs\/[0-9a-f-]{36}$/)
  return href!
}

test.describe('Customs, correcting a bill, as Dave', () => {
  const dave = daveCreds()
  test.skip(!dave, 'Set DAVE_EMAIL/DAVE_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, dave!)
  })

  test('a flag is signed off with a note, leaves the count, and can be undone', async ({ page }) => {
    const flagged = await aFlaggedBill(page)
    const before = await needALook(page)

    await page.goto(flagged)
    await expect(page.getByText('Needs a look').first()).toBeVisible()
    await page.getByLabel('Looked into it?').fill('Storage and exam only; no duty on this one.')
    await page.getByRole('button', { name: 'Mark as checked' }).click()
    await expect(page.getByText(/Checked by .* Storage and exam only; no duty on this one\./)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Checked', { exact: true }).first()).toBeVisible()

    expect(await needALook(page)).toBe(before - 1)

    await page.goto(flagged)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('button', { name: 'Mark as checked' })).toBeVisible({ timeout: 15_000 })
    expect(await needALook(page)).toBe(before)
  })

  test('the reading can be corrected, with the checks worked as it is typed', async ({ page }) => {
    await page.goto(await aFlaggedBill(page))
    await page.getByRole('link', { name: 'Correct the reading' }).click()
    await page.waitForURL(/\/edit$/)

    // The reading as it is: flagged, but its sums hold.
    await expect(page.getByText('Adds up, with something to look at:')).toBeVisible()
    // A total that no longer matches its charges is caught before anything is saved.
    const total = page.getByLabel('Invoice total')
    const was = await total.inputValue()
    await total.fill(String(Number(was) + 1))
    await expect(page.getByText('Does not add up yet:')).toBeVisible()
    await total.fill(was)
    await expect(page.getByText('Adds up, with something to look at:')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.waitForURL(/\/transport\/customs\/[0-9a-f-]{36}$/)
  })
})
