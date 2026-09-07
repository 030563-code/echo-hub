import { test, expect } from '@playwright/test'
import { adminCreds, login } from './helpers'

// Staging-mode E2E. Self-skips unless the run is flagged staging (so the normal
// suite, run without the flag, treats this as a no-op). READ-ONLY by design: the
// staging dev server still points at the prod Supabase via .env.local, so this
// spec never triggers a write — it proves the staging MODE is active end-to-end
// (server-side isStaging() → banner) and that the guarded app still renders
// healthily. The external-write BLOCK itself is covered by tests/unit/staging-guard.
const STAGING = process.env.NEXT_PUBLIC_HUB_ENV === 'staging'

test('staging sandbox: banner renders + app healthy across modules (read-only)', async ({ page }) => {
  test.skip(!STAGING, 'not a staging run (NEXT_PUBLIC_HUB_ENV!=staging)')
  const c = adminCreds()
  test.skip(!c, 'no admin creds in .env.local')

  // Log in against the real running app (staging mode).
  await login(page, c!)

  // (1) The staging banner proves isStaging() is live end-to-end (server layout).
  await expect(page.getByText('STAGING SANDBOX', { exact: false })).toBeVisible()

  // (2) Guarded modules still render (reads healthy; the kill-switch guards don't
  //     break the pages), and the banner persists on each.
  for (const path of ['/purchase-orders', '/invoices', '/bom', '/transport']) {
    await page.goto(path)
    await expect(page).toHaveURL(new RegExp(path.replace('/', '\\/')))
    await expect(page.getByText('STAGING SANDBOX', { exact: false })).toBeVisible()
  }
})
