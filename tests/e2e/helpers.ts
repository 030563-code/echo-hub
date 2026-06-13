import { expect, type Page } from '@playwright/test'

export type Creds = { email: string; password: string }

/** The privileged persona (super-admin) — E2E_USERNAME/E2E_PASSWORD. */
export function adminCreds(): Creds | null {
  const email = process.env.E2E_USERNAME
  const password = process.env.E2E_PASSWORD
  return email && password ? { email, password } : null
}

/** The scoped persona (e.g. quotes-only) — E2E_LIMITED_USERNAME/PASSWORD. */
export function limitedCreds(): Creds | null {
  const email = process.env.E2E_LIMITED_USERNAME
  const password = process.env.E2E_LIMITED_PASSWORD
  return email && password ? { email, password } : null
}

/** Any usable login — prefers admin, falls back to the scoped user. */
export function anyCreds(): Creds | null {
  return adminCreds() ?? limitedCreds()
}

/** Log in via the real form and wait for the dashboard. */
export async function login(page: Page, c: Creds) {
  await page.goto('/login')
  await page.getByPlaceholder('name@echobarrier.com').fill(c.email)
  await page.getByPlaceholder('••••••••').fill(c.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 })
  await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible()
}

/** Proxy for "is this user privileged?" — only admins/ops users see the MRP nav. */
export async function canSeeMrp(page: Page): Promise<boolean> {
  return (await page.locator('aside').getByRole('link', { name: 'MRP', exact: true }).count()) > 0
}
