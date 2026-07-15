import { test, expect } from "@playwright/test";
import { adminCreds, login } from "./helpers";

// Drives the ATOMIC approval chain (hub_approve_po_leg RPC, 2026-07-14) through
// the real UI: raise a depot PO → approve tier 1 → the Group leg appears WITH a
// reference → approve tier 2 → the SRO leg appears with a reference. The exact
// reference values (child.reference_po_number === parent.po_number) are asserted
// DB-side by the orchestrator after the run; this spec proves the user-visible
// flow. The SRO leg is left un-approved (terminal) and the whole chain is tagged
// with MARKER in notes for external cleanup.
//
// SAFETY: approvals hand off to live n8n → Xero. Run this spec ONLY while the
// n8n workflow is deactivated (or with N8N_PO_APPROVED_WEBHOOK_URL unset) — the
// orchestrator brackets the run. The approve still succeeds; the notice then
// reads "…hand-off did not confirm / could not be reached", which is accepted.

const MARKER = "E2E-APPROVE-CHAIN-MARKER do-not-keep";

test("PO approve chain: raise → tier1 → tier2(ref) → tier3(ref)", async ({ page }) => {
  test.setTimeout(150_000);
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");
  await login(page, c!);

  // ---- raise a US-BAL root PO with the marker note ----
  await page.goto("/purchase-orders/create");
  await page.locator("select[required]").selectOption("US-BAL");
  await page.locator("select").filter({ hasText: "Select product…" }).first().selectOption("EBH9NA");
  await page.getByLabel("Quantity").fill("7");
  await page.getByLabel("Unit price").fill("106");
  await page.getByPlaceholder("Anything EB Group should know about this order…").fill(MARKER);
  await page.getByRole("button", { name: "Raise PO for approval" }).click();
  await expect(page.getByText("Purchase order raised").first()).toBeVisible({ timeout: 15_000 });

  // Target each tier's card by its ROUTE text — placeholder numbers are hidden
  // ("Awaiting Xero PO number") so the from → to pair is the unambiguous anchor,
  // and the auto-retrying visibility waits ride through router.refresh.
  const markerCard = (route: string) =>
    page.locator("div.rounded-xl").filter({ hasText: MARKER }).filter({ hasText: route });
  const t1 = markerCard("US-BAL → EB-GROUP");
  const t2 = markerCard("EB-GROUP → EB-SRO");
  const t3 = markerCard("EB-SRO → SUPPLIER");

  // ---- tier 1: Depot → approve ----
  await page.goto("/purchase-orders/approvals");
  await expect(t1).toBeVisible();
  await t1.getByRole("button", { name: "Approve" }).click();

  // ---- tier 2: the Group leg appears (proves the child was raised), with a ref ----
  await expect(t2).toBeVisible({ timeout: 25_000 });
  await expect(t2.getByText("ref:", { exact: false })).toBeVisible();
  await t2.getByRole("button", { name: "Approve" }).click();

  // ---- tier 3: the SRO leg appears with a ref; tier 2 has left the queue ----
  await expect(t3).toBeVisible({ timeout: 25_000 });
  await expect(t3.getByText("ref:", { exact: false })).toBeVisible();
  await expect(t2).toBeHidden({ timeout: 25_000 });

  // The board never shows internal placeholders — the new card reads "Awaiting
  // Xero PO number" until n8n writes the real number back.
  await expect(t3.getByText("Awaiting Xero PO number").first()).toBeVisible();
});
