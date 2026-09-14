import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

const c = anyCreds()

test.describe('Open on phone', () => {
  test('the header button shows a QR code for the page on screen', async ({ page }) => {
    test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')
    await login(page, c!)

    // The dashboard exists for every user. The query string proves the code
    // carries it, and the hash proves the code drops it.
    await page.goto('/?from=qr-test#section')
    const expected = new URL(page.url())
    expected.hash = ''
    const expectedUrl = `${expected.origin}${expected.pathname}${expected.search}`

    await page.getByRole('button', { name: 'Open this page on your phone' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Open on your phone' })).toBeVisible()
    await expect(dialog.locator('svg[role="img"]')).toBeVisible()
    await expect(dialog.getByTestId('open-on-phone-url')).toHaveText(expectedUrl)
    expect(expectedUrl).not.toContain('#')
    expect(expectedUrl).toContain('from=qr-test')
  })
})
