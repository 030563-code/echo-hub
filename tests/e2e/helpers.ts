import { expect, type Page } from '@playwright/test'

export function creds() {
  // Fall back to the limited creds — in this deployment there's a single real
  // login (the super-admin), so E2E_LIMITED_* may be the only pair set.
  const email = process.env.E2E_USERNAME || process.env.E2E_LIMITED_USERNAME
  const password = process.env.E2E_PASSWORD || process.env.E2E_LIMITED_PASSWORD
  if (!email || !password) {
    throw new Error('Set E2E_USERNAME/E2E_PASSWORD (or E2E_LIMITED_*) in .env.local')
  }
  return { email, password }
}

/** A scoped (non-admin) user for negative-gating tests — optional. */
export function limitedCreds() {
  return {
    email: process.env.E2E_LIMITED_USERNAME,
    password: process.env.E2E_LIMITED_PASSWORD,
  }
}

/** Log in via the real login form and wait for the dashboard. */
export async function login(page: Page, email = creds().email, password = creds().password) {
  await page.goto('/login')
  await page.getByPlaceholder('name@echobarrier.com').fill(email)
  await page.getByPlaceholder('••••••••').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 })
  await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible()
}
