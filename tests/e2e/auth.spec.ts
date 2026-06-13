import { test, expect } from '@playwright/test'
import { login, creds } from './helpers'

test.describe('Authentication + session gate', () => {
  test('unauthenticated visit to a protected route redirects to /login', async ({ page }) => {
    await page.goto('/quotes')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Hub Login' })).toBeVisible()
  })

  test('the login page renders its logo (static assets are not gated)', async ({ page }) => {
    await page.goto('/login')
    const logo = page.getByAltText('Echo Barrier').first()
    await expect(logo).toBeVisible()
    // The <img> actually resolved to a real image (naturalWidth > 0), i.e. not 307'd.
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  })

  test('bad credentials show an error and stay on /login', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('name@echobarrier.com').fill(creds().email)
    await page.getByPlaceholder('••••••••').fill('definitely-the-wrong-password')
    await page.getByRole('button', { name: 'Sign In' }).click()
    await expect(page.locator('text=/invalid|credentials/i').first()).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('valid credentials land on the dashboard', async ({ page }) => {
    await login(page)
    await expect(page).toHaveURL('http://localhost:3000/')
  })
})
