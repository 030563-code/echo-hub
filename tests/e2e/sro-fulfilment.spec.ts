import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminCreds, login } from "./helpers";
import { deletePurchaseOrdersByNotes, serviceClient } from "./db-helpers";

// The SRO fulfilment step (8 Sep 2026), through the real UI against the running
// server:
//   - an approved Group → SRO order shows the stock-or-manufacture card, with
//     both buttons on screen and enabled and the H9 buildable figure beside them;
//   - Fulfil from stock records the decision, and the card leaves the page;
//   - Manufacture pressed in two tabs at once raises exactly ONE Bamida order,
//     and a third, stale tab pressing Fulfil from stock is refused;
//   - the Bamida order's own page shows Send to Bamida (never pressed here:
//     pressing it calls n8n);
//   - the board keeps the SRO order and the unsent Bamida order at S.R.O;
//   - the supplier link works with no login: dates save, Manufacturing finished
//     is one-shot even when two browsers race it, a wrong link is refused, and
//     the finished order shows on the board under Shipping;
//   - finishing drafts the shipment request, and the review card offers it for
//     approval with the Incoterm still blank.
//
// Self-contained: fixtures are created in beforeAll with the service-role key
// from .env.local and removed in afterAll (CASCADE takes lines, po_manufacturing,
// po_cargo_request and the token).
//
// ONE BUTTON HERE REACHES n8n. Since 9 Sep, Manufacturing finished emails us to
// say an order is ready for shipment, so a run sends one email. That is why the
// spec refuses to run unless HUB_EMAIL_TEST_RECIPIENT is set: without it a
// fixture order would tell Juraj that barriers he has never heard of are ready.
// Send to Bamida and Approve and send are still only ever looked at, never
// pressed: those two reach a factory and a freight forwarder.

const TAG = "E2E SRO FULFILMENT FIXTURE";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type Fixture = { id: string; po_number: string };

async function makePo(
  sb: SupabaseClient,
  leg: string,
  from: string,
  to: string,
  quantity: number,
  poNumber: string,
): Promise<Fixture> {
  await sb.from("purchase_orders").delete().eq("po_number", poNumber);
  const { data, error } = await sb
    .from("purchase_orders")
    .insert({
      leg,
      from_entity: from,
      to_entity: to,
      status: "approved",
      source: "hub",
      requested_by: "E2E",
      approved_by: "E2E",
      notes: TAG,
      po_number: poNumber,
    })
    .select("id, po_number")
    .single();
  if (error) throw error;
  const { error: lineErr } = await sb.from("purchase_order_lines").insert({
    po_id: data.id,
    sku: "EBH9NA",
    product_name: "Echo Barrier H9",
    product_family: "H9",
    quantity,
  });
  if (lineErr) throw lineErr;
  return data as Fixture;
}

// The kanban column whose header reads `label`. .first() for the same reason as
// po-lifecycle-kanban.spec.ts: a card's leg badge can share a column's label.
const column = (page: Page, label: string) =>
  page.locator("div.w-64").filter({ has: page.getByText(label, { exact: true }) }).first();

// The board remembers kanban-or-table per user, so ask for the kanban explicitly.
async function openKanban(page: Page) {
  await page.goto("/purchase-orders");
  await page.getByRole("button", { name: "Kanban" }).click();
  await expect(page.getByText("S.R.O", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

const sb = serviceClient();
const creds = adminCreds();
let stockPo: Fixture;
let manufacturePo: Fixture;
let bamidaPo: Fixture;
let supplierLink = "";

test.beforeAll(async () => {
  if (!sb || !creds) return;
  stockPo = await makePo(sb, "EB_GROUP_TO_SRO", "EB-GROUP", "EB-SRO", 20, "E2EPO26004");
  // 500 H9 is more than Bamida can build from the shelf, so this one shows the
  // shortage block as well.
  manufacturePo = await makePo(sb, "EB_GROUP_TO_SRO", "EB-GROUP", "EB-SRO", 500, "E2EPO26005");
  // A Bamida order as it stands after Manufacture and before Send: a bare
  // po_manufacturing row and the link the email would have carried.
  bamidaPo = await makePo(sb, "SRO_TO_SUPPLIER", "EB-SRO", "SUPPLIER", 20, "E2EPO26006");
  const { error: mErr } = await sb.from("po_manufacturing").insert({ po_id: bamidaPo.id });
  if (mErr) throw mErr;
  supplierLink = randomBytes(32).toString("base64url");
  const { error: tErr } = await sb.from("manufacturing_access_tokens").insert({
    token_hash: createHash("sha256").update(supplierLink).digest("hex"),
    po_id: bamidaPo.id,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (tErr) throw tErr;
});

test.afterAll(async () => {
  if (sb) await deletePurchaseOrdersByNotes(sb, TAG);
});

test.beforeEach(async () => {
  test.skip(!creds, "no admin creds in .env.local");
  test.skip(!sb, "no service-role key in .env.local");
  // Manufacturing finished emails whoever the Hub decides. With the override on
  // that is the tester; without it, it is Juraj, about an order that does not
  // exist. Refuse rather than send.
  test.skip(
    !process.env.HUB_EMAIL_TEST_RECIPIENT,
    "HUB_EMAIL_TEST_RECIPIENT is not set: pressing finished would email the real recipient",
  );
});

test("an approved SRO order offers stock or manufacture, with the buildable figure", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await page.goto(`/purchase-orders/${stockPo.id}`);
  await expect(page.getByRole("heading", { name: stockPo.po_number })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "How is this order being fulfilled?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fulfil from stock" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manufacture", exact: true })).toBeEnabled();
  await expect(page.getByText(/max buildable now: \d+/)).toBeVisible();
  await expect(page.getByText("never counted")).toBeVisible();
});

test("Fulfil from stock records the decision and takes the card away", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await page.goto(`/purchase-orders/${stockPo.id}`);
  await page.getByRole("button", { name: "Fulfil from stock" }).click();
  await expect(page.getByText("Recorded: this order is being fulfilled from SRO stock.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("SRO are fulfilling this from their own stock, so no manufacturing order was raised."),
  ).toBeVisible({ timeout: 15_000 });
  // The status shows as the board's own badge, not as a raw column value.
  await expect(page.getByText("From Stock", { exact: true }).first()).toBeVisible();
});

test("Manufacture pressed in two tabs at once raises exactly one Bamida order", async ({ page, context }) => {
  test.setTimeout(150_000);
  await login(page, creds!);
  const second = await context.newPage();
  const stale = await context.newPage();
  for (const p of [page, second, stale]) {
    await p.goto(`/purchase-orders/${manufacturePo.id}`);
    await expect(p.getByRole("button", { name: "Manufacture", exact: true })).toBeEnabled({ timeout: 30_000 });
  }
  // The shortage a 500-unit order causes is on screen before anyone presses.
  await expect(page.getByText(/Short for 500 units/)).toBeVisible();

  await Promise.all([
    page.getByRole("button", { name: "Manufacture", exact: true }).click(),
    second.getByRole("button", { name: "Manufacture", exact: true }).click(),
  ]);
  const outcome = /Manufacturing order .* raised|already exists for this SRO order|already being manufactured/;
  await expect(page.getByText(outcome).first()).toBeVisible({ timeout: 20_000 });
  await expect(second.getByText(outcome).first()).toBeVisible({ timeout: 20_000 });

  // Exactly one child, whichever tab won.
  const { data: children } = await sb!
    .from("purchase_orders")
    .select("id, po_number")
    .eq("parent_po_id", manufacturePo.id)
    .eq("leg", "SRO_TO_SUPPLIER");
  expect(children).toHaveLength(1);

  // A tab that never refreshed still shows the card; its stock press is refused.
  await stale.getByRole("button", { name: "Fulfil from stock" }).click();
  await expect(
    stale.getByText("This order is already being manufactured, so it cannot come from stock."),
  ).toBeVisible({ timeout: 15_000 });

  // The Bamida order it raised is ready to send, and not sent.
  await page.goto(`/purchase-orders/${children![0].id}`);
  await expect(page.getByRole("heading", { name: "Manufacturing", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send to Bamida" })).toBeEnabled();
  await expect(page.getByText("not yet").first()).toBeVisible();
});

test("the board keeps the SRO order and the unsent Bamida order at S.R.O", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await openKanban(page);
  const sro = column(page, "S.R.O");
  // Fulfilling from stock is SRO's own work.
  await expect(sro.getByText(stockPo.po_number, { exact: true })).toBeVisible();
  // Choosing to manufacture leaves the SRO order at SRO; the Bamida order travels.
  await expect(sro.getByText(manufacturePo.po_number, { exact: true })).toBeVisible();
  await expect(column(page, "Manufacturing in progress").getByText(manufacturePo.po_number, { exact: true })).toHaveCount(0);
  const { data: child } = await sb!
    .from("purchase_orders")
    .select("po_number")
    .eq("parent_po_id", manufacturePo.id)
    .maybeSingle();
  expect(child).not.toBeNull();
  await expect(sro.getByText(child!.po_number, { exact: true })).toBeVisible();
  await expect(sro.getByText(bamidaPo.po_number, { exact: true })).toBeVisible();
});

test("the supplier link needs no login: dates save, finished is one-shot, a wrong link is refused", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const first = await browser.newContext({ baseURL: BASE_URL });
  const a = await first.newPage();
  await a.goto(`/manufacturing/${supplierLink}`);
  await expect(a.getByRole("heading", { name: `Purchase order ${bamidaPo.po_number}` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(a.getByRole("button", { name: "Save dates" })).toBeEnabled();
  await expect(a.getByRole("button", { name: "Manufacturing finished" })).toBeEnabled();
  // Not a price anywhere on a supplier's screen.
  await expect(a.getByText(/unit price|€|EUR/i)).toHaveCount(0);

  await a.locator('input[type="date"]').nth(0).fill("2026-09-10");
  await a.locator('input[type="date"]').nth(1).fill("2026-09-24");
  await a.getByRole("button", { name: "Save dates" }).click();
  await expect(a.getByText("Saved. Thank you.")).toBeVisible({ timeout: 15_000 });

  // Two browsers press finished together. One wins; the other is told so.
  const secondBrowser = await browser.newContext({ baseURL: BASE_URL });
  const b = await secondBrowser.newPage();
  await b.goto(`/manufacturing/${supplierLink}`);
  await expect(b.getByRole("button", { name: "Manufacturing finished" })).toBeEnabled({ timeout: 30_000 });
  for (const p of [a, b]) await p.getByRole("button", { name: "Manufacturing finished" }).click();
  await Promise.all([
    a.getByRole("button", { name: "Yes, it is finished" }).click(),
    b.getByRole("button", { name: "Yes, it is finished" }).click(),
  ]);
  const won = /You marked this order finished on/;
  const lost = "This order is already marked finished.";
  await expect(a.getByText(won).or(a.getByText(lost))).toBeVisible({ timeout: 20_000 });
  await expect(b.getByText(won).or(b.getByText(lost))).toBeVisible({ timeout: 20_000 });
  const refusals = (await a.getByText(lost).count()) + (await b.getByText(lost).count());
  expect(refusals).toBe(1);

  const { data: row } = await sb!
    .from("po_manufacturing")
    .select("finished_at, est_start, est_finish")
    .eq("po_id", bamidaPo.id)
    .single();
  expect(row).not.toBeNull();
  expect(row!.finished_at).not.toBeNull();
  expect(row!.est_start).toBe("2026-09-10");
  expect(row!.est_finish).toBe("2026-09-24");

  // Back on the link there is nothing left to press.
  await a.reload();
  await expect(a.getByText(won)).toBeVisible({ timeout: 30_000 });
  await expect(a.getByRole("button", { name: "Manufacturing finished" })).toHaveCount(0);

  await a.goto("/manufacturing/not-a-real-link");
  await expect(a.getByText("This link is not valid.")).toBeVisible({ timeout: 30_000 });

  await first.close();
  await secondBrowser.close();
});

test("after Bamida press finished the Hub says so, and the board moves it to Shipping", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await page.goto(`/purchase-orders/${bamidaPo.id}`);
  await expect(
    page.getByText("Bamida have finished this order, so it can no longer be sent or reopened."),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send to Bamida" })).toHaveCount(0);
  await openKanban(page);
  await expect(column(page, "Shipping").getByText(bamidaPo.po_number, { exact: true })).toBeVisible();
});

// A label wraps its own control on the shipment request card, so filter on the
// label text and reach inside it. Text alone would also match the read-only
// summary rows.
const field = (page: Page, label: string) =>
  page.locator("label").filter({ hasText: label }).first();

test("finishing drafts a shipment request, editable and not sent", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);

  // Drafted by the finish in the previous test, never by a person.
  const { data: drafted } = await sb!
    .from("po_cargo_request")
    .select("request, sent_at")
    .eq("po_id", bamidaPo.id)
    .single();
  expect(drafted).not.toBeNull();
  expect(drafted!.sent_at).toBeNull();
  const draft = drafted!.request as Record<string, unknown>;
  expect(draft.delivery_term).toBeNull();
  expect(draft.pieces).toBe(1); // 20 units, 70 to a pallet, and a part pallet is a pallet
  expect(draft.description).toBe("Acoustic Barriers H9");
  expect(draft.cargo_readiness_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await page.goto(`/purchase-orders/${bamidaPo.id}`);
  await expect(page.getByRole("heading", { name: "Shipment request" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Nothing leaves until you press Approve and send/)).toBeVisible();

  // The Incoterm is the field nobody has answered, so it starts blank and says so.
  const incoterm = field(page, "Incoterm").locator("select");
  await expect(incoterm).toHaveValue("");
  await expect(page.getByText(/No Incoterm\./)).toBeVisible();

  // Editable, and the edit survives a save that sends nothing.
  await incoterm.selectOption("DAP");
  await field(page, "Anything else they should know").locator("textarea").fill("Gate closes at 15:00");
  await page.getByRole("button", { name: "Save without sending" }).click();
  await expect(page.getByText("Saved. Nothing has been sent yet.")).toBeVisible({ timeout: 15_000 });

  const { data: saved } = await sb!
    .from("po_cargo_request")
    .select("request, sent_at")
    .eq("po_id", bamidaPo.id)
    .single();
  const after = saved!.request as Record<string, unknown>;
  expect(after.delivery_term).toBe("DAP");
  expect(after.notes).toBe("Gate closes at 15:00");
  expect(saved!.sent_at).toBeNull(); // saving is not sending

  // Present, enabled, and deliberately not pressed: it emails a freight forwarder.
  await expect(page.getByRole("button", { name: "Approve and send" })).toBeEnabled();
});
