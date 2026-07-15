import { test, expect, type Page, type Locator } from "@playwright/test";
import { adminCreds, login } from "./helpers";
import { sroState } from "./sro-helpers";

// Drives the two 2026-07-13 changes end-to-end in a real browser:
//   1) the PO board's leg-based lifecycle kanban + drag-to-move (persisted), and
//   2) commercial-invoice creation having moved Transport → /invoices.
// Admin persona (super-admin → po.approve ⇒ cards draggable, invoice.create ⇒
// panel visible). The drag mutates lifecycle_stage (presentation only); the spec
// restores the card's column at the end and is self-healing if a previous run
// died mid-test (it normalises the card's column first).

const s = sroState();

// .first() matters: a card's LEG badge can read the same text as a column label
// (e.g. the DEPOT_TO_EB_GROUP leg badge is "Depot → Group", identical to that
// lifecycle-stage column's own label) — once such a card sits in ANOTHER column,
// that column's div also satisfies the `has` filter. Columns render in a fixed
// order (LIFECYCLE_STAGES), so .first() deterministically resolves to the real
// column, not a column merely hosting a same-labelled card.
const col = (page: Page, label: string) =>
  page.locator("div.w-64").filter({ has: page.getByText(label, { exact: true }) }).first();

// Drag `card` onto `target` and wait until the card RENDERS inside it. Retries
// the whole gesture: dispatching drag events straight after navigation can race
// React hydration (handlers not attached yet → the drop silently no-ops), which
// both flaked the old toast assertion and could strand the card mid-board.
// Dropping on the card's current column is a no-op in the app, so the first
// attempt's membership check simply passes — safe to use as a normaliser.
async function dragTo(page: Page, card: Locator, target: Locator, poNumber: string) {
  for (let attempt = 0; ; attempt++) {
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent("dragstart", { dataTransfer: dt });
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await target.dispatchEvent("drop", { dataTransfer: dt });
    await card.dispatchEvent("dragend", { dataTransfer: dt });
    try {
      await expect(target.getByText(poNumber, { exact: true })).toBeVisible({ timeout: 5_000 });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

test("PO lifecycle kanban drags + persists; invoices create panel moved", async ({ page }) => {
  test.setTimeout(120_000);
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");
  test.skip(!s, "Run `node tests/e2e/_setup.mjs` first");
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

  // The DEPOT_TO_EB_GROUP fixture — its number is a real, displayable E2E number
  // (not a Hub placeholder), so it's a deterministic text target like any real PO.
  const poNumber = s!.receivePo.po_number;
  const card = page.locator('[draggable="true"]').filter({ hasText: poNumber });
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Normalise: put the card in its home column first (no-op when already there;
  // self-heals leftover state if a previous run died between drag and drag-back).
  await dragTo(page, card, col(page, "Depot → Group"), poNumber);

  // ---- drag → "Sent to manufacturing", then prove it PERSISTED ----
  await dragTo(page, card, col(page, "Sent to manufacturing"), poNumber);
  await page.reload();
  await expect(col(page, "Sent to manufacturing").getByText(poNumber, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // ---- /invoices: the create panel now lives here ----
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Commercial Invoices" })).toBeVisible();
  await expect(page.getByText("New invoice — from a container")).toBeVisible();

  // ---- /transport: no invoice create panel anymore (pure logistics) ----
  await page.goto("/transport");
  await expect(page.getByText("Logistics & Shipping")).toBeVisible();
  await expect(page.getByText("New invoice — from a container")).toHaveCount(0);

  // ---- restore: drag the card home + prove the restore persisted too ----
  await page.goto("/purchase-orders");
  const cardBack = page.locator('[draggable="true"]').filter({ hasText: poNumber });
  await expect(cardBack).toBeVisible({ timeout: 10_000 });
  await dragTo(page, cardBack, col(page, "Depot → Group"), poNumber);
  await page.reload();
  await expect(col(page, "Depot → Group").getByText(poNumber, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});
