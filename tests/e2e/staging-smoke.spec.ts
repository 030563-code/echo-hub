import { test, expect, type Page } from "@playwright/test";
import { adminCreds, login } from "./helpers";

// Full guide-flow smoke against the DEPLOYED staging site (E2E_BASE_URL). Proves
// what testers will actually do works end to end on the real URL: the sandbox
// banner (kill switch), raising a PO with the now-required delivery address,
// approving up the chain with the reference carrying, the board's "Awaiting Xero"
// display, and the PO PDF download.
//
//   E2E_BASE_URL=https://echo-hub-staging.netlify.app \
//     npx playwright test --config=playwright.remote.config.ts
//
// SAFETY: the STAGING-banner assertion runs BEFORE any Approve click, so if the
// deploy were NOT in sandbox mode the test aborts before anything could reach
// n8n/Xero. The marker chain it creates is deleted afterwards (staging shares the
// prod Supabase, so cleanup is by the orchestrator via the MARKER note).

const MARKER = "STAGING-SMOKE-MARKER do-not-keep";
const col = (page: Page, label: string) =>
  page.locator("div.w-64").filter({ has: page.getByText(label, { exact: true }) }).first();
const markerCard = (page: Page, route: string) =>
  page.locator("div.rounded-xl").filter({ hasText: MARKER }).filter({ hasText: route });

test("staging: raise (required delivery) -> approve chain (ref) -> board + PDF", async ({ page }) => {
  test.setTimeout(240_000);
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");
  await login(page, c!);

  // GATE — must be in sandbox mode before we click any Approve (else abort here).
  await expect(page.getByText("STAGING SANDBOX", { exact: false })).toBeVisible({ timeout: 20_000 });

  // ---- raise, proving the delivery address is required ----
  await page.goto("/purchase-orders/create");
  await page.locator('select[required]').first().selectOption("US-BAL");
  await page.locator('select[required]').nth(1).selectOption({ index: 1 }); // delivery (required)
  await page.locator("select").filter({ hasText: "Select product…" }).first().selectOption("EBH9NA");
  await page.getByLabel("Quantity").first().fill("3");
  const price = page.getByLabel("Unit price").first();
  if (await price.count()) await price.fill("50");
  await page.getByPlaceholder("Anything EB Group should know about this order…").fill(MARKER);
  await page.getByRole("button", { name: "Raise PO for approval" }).click();
  await expect(page.getByText("Purchase order raised").first()).toBeVisible({ timeout: 25_000 });

  // ---- approve tier 1 -> tier 2 appears with a ref -> approve -> tier 3 with a ref ----
  await page.goto("/purchase-orders/approvals");
  const t1 = markerCard(page, "US-BAL → EB-GROUP");
  await expect(t1).toBeVisible({ timeout: 20_000 });
  await t1.getByRole("button", { name: "Approve" }).click();

  const t2 = markerCard(page, "EB-GROUP → EB-SRO");
  await expect(t2).toBeVisible({ timeout: 30_000 });
  await expect(t2.getByText("ref:", { exact: false })).toBeVisible();
  await t2.getByRole("button", { name: "Approve" }).click();

  const t3 = markerCard(page, "EB-SRO → SUPPLIER");
  await expect(t3).toBeVisible({ timeout: 30_000 });
  await expect(t3.getByText("ref:", { exact: false })).toBeVisible();
  await expect(t3.getByText("Awaiting Xero PO number").first()).toBeVisible();

  // ---- board: lifecycle columns + "Awaiting Xero" display + a real PDF download ----
  await page.goto("/purchase-orders");
  for (const label of ["Depot → Group", "Group → S.R.O", "Sent to manufacturing", "Shipping"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Awaiting Xero PO number").first()).toBeVisible();

  await page.locator('[draggable="true"]').first().click();
  const dl = page.getByRole("button", { name: "Download PDF" });
  await expect(dl).toBeVisible({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), dl.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);

  // ---- invoices page loads with the create panel ----
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Commercial Invoices" })).toBeVisible();
  await expect(page.getByText("New invoice — from a container")).toBeVisible();
});
