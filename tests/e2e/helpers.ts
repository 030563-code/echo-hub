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

/** Claire, the France persona: one organisation, and invoicing.manage as a
 *  real row rather than through super admin. CLAIRE_EMAIL/CLAIRE_PASSWORD. */
export function claireCreds(): Creds | null {
  const email = process.env.CLAIRE_EMAIL
  const password = process.env.CLAIRE_PASSWORD
  return email && password ? { email, password } : null
}

/** Any usable login — prefers admin, falls back to the scoped user. */
export function anyCreds(): Creds | null {
  return adminCreds() ?? limitedCreds()
}

/** Log in via the real form and wait for the dashboard. Host-agnostic, so it works
 *  against localhost AND a deployed URL (E2E_BASE_URL). */
export async function login(page: Page, c: Creds) {
  await page.goto('/login')
  await page.getByPlaceholder('name@echobarrier.com').fill(c.email)
  await page.getByPlaceholder('••••••••').fill(c.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  // Relative, so the suite follows the config's baseURL. An absolute
  // localhost:3000 pinned it to one port and broke on any machine where
  // something else already held it. The generous timeouts are for a cold
  // dev server compiling the route on first visit.
  try {
    await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 25_000 })
  } catch (error) {
    // 🔴 On a failure Playwright attaches a snapshot of the page to the report
    // (error-context.md), and that snapshot includes the TEXT typed into every
    // field, password fields included. A login that fails must therefore not
    // leave the password on the page, or the secret lands in the test output
    // and in whatever reads it. Best effort: the page may already be gone.
    await page.getByPlaceholder('••••••••').fill('').catch(() => {})
    throw error
  }
  await expect(page.getByText('Welcome to the Echo Barrier Hub')).toBeVisible({ timeout: 15_000 })
}

/** Proxy for "is this user privileged?" — only admins/ops users see the MRP nav. */
export async function canSeeMrp(page: Page): Promise<boolean> {
  return (await page.locator('aside').getByRole('link', { name: 'Stock Prediction Engine', exact: true }).count()) > 0
}

/**
 * Put the quote builder back to a clean, draft-free state.
 *
 * The builder now saves what the rep is doing, so completing setup leaves a row
 * behind for this persona and the NEXT run would arrive to a restored draft
 * instead of the setup dialog. Clicking Start again deletes it.
 *
 * Waits for the builder to finish reading before deciding: the draft is loaded
 * in the browser, so for the first frames neither the strip nor the dialog is on
 * screen and a bare isVisible() check would race it.
 */
export async function clearQuoteDraft(page: Page, dealId: string) {
  await page.goto(`/quotes/create/${dealId}`)
  const strip = page.getByRole('button', { name: /Start this quote again/i })
  const setup = page.getByText('Quote Setup')
  await expect(strip.or(setup).first()).toBeVisible({ timeout: 30000 })
  if (await strip.isVisible()) await strip.click()
}
