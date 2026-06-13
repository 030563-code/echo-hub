import { expect, type Page } from '@playwright/test'

export function creds() {
  const email = process.env.E2E_USERNAME
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    throw new Error('E2E_USERNAME / E2E_PASSWORD not set in .env.local')
  }
  return { email, password }
}

/** Log in via the real login form and wait for the dashboard. */
export async function login(page: Page) {
  const { email, password } = creds()
  await page.goto('/login')
  await page.getByPlaceholder('name@echobarrier.com').fill(email)
  await page.getByPlaceholder('••••••••').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  // Successful auth replaces to the dashboard root.
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 })
  await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible()
}
