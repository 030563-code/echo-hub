import { test, expect } from "@playwright/test";
import { adminCreds, login } from "./helpers";

// Drives the two 2026-07-13 changes end-to-end in a real browser:
//   1) the PO board's leg-based lifecycle kanban + drag-to-move (persisted), and
//   2) commercial-invoice creation having moved Transport → /invoices.
// Admin persona (super-admin → po.approve ⇒ cards draggable, invoice.create ⇒
// panel visible). The drag mutates lifecycle_stage (presentation only); the spec
// leaves the board as it found it is handled by the caller's DB reset.

const col = (page: import("@playwright/test").Page, label: string) =>
  page.locator("div.w-64").filter({ has: page.getByText(label, { exact: true }) });

test("PO lifecycle kanban drags + persists; invoices create panel moved", async ({ page }) => {
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");
  await login(page, c!);

  // ---- /purchase-orders: the 6 leg-based columns render ----
  await page.goto("/purchase-orders");
  for (const label of [
    "Depot → Group",
    "Group → S.R.O",
    "Sent to manufacturing",
    "Manufacturing in progress",
    "Shipping",
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // ---- drag whatever card sits in "S.R.O" → "Sent to manufacturing" ----
  const sro = col(page, "S.R.O");
  const card = sro.locator('[draggable="true"]').first();
  const hasCard = (await card.count()) > 0;
  test.skip(!hasCard, "no draggable card in the S.R.O column to move");

  // Capture the card's PO number (2nd font-mono <p>) to re-find it after reload.
  const poNumber = (await card.locator("p.font-mono").nth(1).innerText()).trim();
  const sent = col(page, "Sent to manufacturing");
  // A global locator for the card — survives the optimistic move out of S.R.O
  // (the column-scoped one goes stale the instant it re-renders elsewhere).
  const cardAny = page.locator('[draggable="true"]').filter({ hasText: poNumber });

  // Native HTML5 DnD via a shared DataTransfer (the documented Playwright pattern).
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await cardAny.dispatchEvent("dragstart", { dataTransfer: dt });
  await sent.dispatchEvent("dragover", { dataTransfer: dt });
  await sent.dispatchEvent("drop", { dataTransfer: dt });
  await cardAny.dispatchEvent("dragend", { dataTransfer: dt });

  // Optimistic move: the card appears under the new column immediately.
  await expect(sent.getByText(poNumber, { exact: true })).toBeVisible({ timeout: 10_000 });

  // Wait for the server action to CONFIRM (success toast) before reloading — the
  // toast only fires after setPoStage → RPC resolves, so the DB write has landed.
  await expect(page.getByText("Moved to", { exact: false })).toBeVisible({ timeout: 10_000 });

  // Persisted through the server action + RPC: still there after a full reload.
  await page.reload();
  await expect(col(page, "Sent to manufacturing").getByText(poNumber, { exact: true })).toBeVisible();

  // ---- /invoices: the create panel now lives here ----
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Commercial Invoices" })).toBeVisible();
  await expect(page.getByText("New invoice — from a container")).toBeVisible();

  // ---- /transport: no invoice create panel anymore (pure logistics) ----
  await page.goto("/transport");
  await expect(page.getByText("Logistics & Shipping")).toBeVisible();
  await expect(page.getByText("New invoice — from a container")).toHaveCount(0);

  // ---- teardown: drag the card back to S.R.O so the demo board is left as found
  // (restores its original derived column; visually net-zero) ----
  await page.goto("/purchase-orders");
  const back = page.locator('[draggable="true"]').filter({ hasText: poNumber });
  const sroBack = col(page, "S.R.O");
  const dt2 = await page.evaluateHandle(() => new DataTransfer());
  await back.dispatchEvent("dragstart", { dataTransfer: dt2 });
  await sroBack.dispatchEvent("dragover", { dataTransfer: dt2 });
  await sroBack.dispatchEvent("drop", { dataTransfer: dt2 });
  await back.dispatchEvent("dragend", { dataTransfer: dt2 });
  await expect(page.getByText("Moved to", { exact: false })).toBeVisible({ timeout: 10_000 });
});
