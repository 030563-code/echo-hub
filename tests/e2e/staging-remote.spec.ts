import { test, expect } from "@playwright/test";
import { adminCreds } from "./helpers";

// Verifies a DEPLOYED staging site (E2E_BASE_URL). READ-ONLY: logs in and confirms
// the STAGING banner renders (proving NEXT_PUBLIC_HUB_ENV=staging is live on the
// deploy → the external-call kill switch is active) and that the guarded modules
// render. Never writes. Self-skips unless E2E_BASE_URL is set, so the normal suite
// (run without it) ignores this spec.
const REMOTE = !!process.env.E2E_BASE_URL;

test("deployed staging: banner live + modules render (read-only)", async ({ page }) => {
  test.skip(!REMOTE, "remote-only (needs E2E_BASE_URL)");
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");

  // Log in against the deployed site (baseURL from the remote config).
  await page.goto("/login");
  await page.getByPlaceholder("name@echobarrier.com").fill(c!.email);
  await page.getByPlaceholder("••••••••").fill(c!.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByText("Welcome to the Echo Barrier Hub")).toBeVisible({ timeout: 30_000 });

  // The staging banner proves the deploy is in staging mode end-to-end.
  await expect(page.getByText("STAGING SANDBOX", { exact: false })).toBeVisible();

  // Guarded modules render and the banner persists (reads healthy in staging).
  for (const path of ["/purchase-orders", "/invoices", "/bom", "/transport"]) {
    await page.goto(path);
    await expect(page.getByText("STAGING SANDBOX", { exact: false })).toBeVisible();
  }
});
