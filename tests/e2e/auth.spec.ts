import { test, expect } from '@playwright/test'
import { login, anyCreds } from './helpers'

const c = anyCreds()

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
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  })

  test('bad credentials show an error and stay on /login', async ({ page }) => {
    test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')
    await page.goto('/login')
    await page.getByPlaceholder('name@echobarrier.com').fill(c!.email)
    await page.getByPlaceholder('••••••••').fill('definitely-the-wrong-password')
    await page.getByRole('button', { name: 'Sign In' }).click()
    await expect(page.locator('text=/invalid|credentials/i').first()).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('valid credentials land on the dashboard', async ({ page }) => {
    test.skip(!c, 'Set E2E_USERNAME/PASSWORD or E2E_LIMITED_USERNAME/PASSWORD')
    await login(page, c!)
    await expect(page).toHaveURL('http://localhost:3000/')
  })
})
