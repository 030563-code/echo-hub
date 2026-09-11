import { test, expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminCreds, limitedCreds, login } from "./helpers";
import { serviceClient, deletePurchaseOrdersByNotes } from "./db-helpers";

/**
 * The stock board and the ledger behind it, end to end.
 *
 * Everything this touches is a fixture: a made-up SKU at a real warehouse, so
 * the balance rows and movements it creates are deleted by sku in afterAll and
 * no real level moves. The SRO order it books carries that SKU too, so the
 * booking deduction lands on the fixture row. The fulfil-from-stock button
 * emails, so that case refuses to run unless HUB_EMAIL_TEST_RECIPIENT is set,
 * as the SRO fulfilment spec does.
 */

const TAG = "E2E STOCK LEDGER FIXTURE";
const SKU = "E2E-LEDGER-SKU";
const WAREHOUSE = "US-SBD";

interface Fixture {
  id: string;
  po_number: string;
}

async function makeSroOrder(sb: SupabaseClient, quantity: number, poNumber: string): Promise<Fixture> {
  const { data, error } = await sb
    .from("purchase_orders")
    .insert({
      leg: "EB_GROUP_TO_SRO",
      from_entity: "EB-GROUP",
      to_entity: "EB-SRO",
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
    sku: SKU,
    product_name: "E2E ledger fixture",
    product_family: "E2E",
    quantity,
  });
  if (lineErr) throw lineErr;
  return data as Fixture;
}

async function cleanup(sb: SupabaseClient) {
  const { data: pos } = await sb.from("purchase_orders").select("id").eq("notes", TAG);
  const ids = (pos ?? []).map((p) => p.id as string);
  if (ids.length) await sb.from("po_shipments").delete().in("po_id", ids);
  await deletePurchaseOrdersByNotes(sb, TAG);
  await sb.from("stock_movements").delete().eq("sku", SKU);
  await sb.from("warehouse_stock_levels").delete().eq("sku", SKU);
}

const sb = serviceClient();
const creds = adminCreds();
let sroPo: Fixture;

test.beforeAll(async () => {
  if (!sb) return;
  await cleanup(sb);
  sroPo = await makeSroOrder(sb, 10, "E2EPO26011");
});

test.afterAll(async () => {
  if (sb) await cleanup(sb);
});

test.beforeEach(async () => {
  test.skip(!creds, "no admin creds in .env.local");
  test.skip(!sb, "no service-role key in .env.local");
});

const section = (page: Page, warehouse: string) => page.locator(`[data-stock-warehouse="${warehouse}"]`);
const rowFor = (page: Page, warehouse: string, sku: string) =>
  section(page, warehouse).locator("tr", { has: page.getByText(sku, { exact: true }) });

test("the board has three tabs and a section per warehouse; a limited user is turned away", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await page.goto("/stock");
  await expect(page).toHaveURL(/\/stock\/finished$/);
  for (const tab of ["Finished goods", "Materials", "Movements"]) {
    await expect(page.getByRole("link", { name: tab })).toBeVisible();
  }
  // The fixture SRO order is ready to count against nothing yet; the depot
  // sections exist for whatever the balance table holds today.
  await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible();

  await page.getByRole("link", { name: "Movements" }).click();
  await expect(page).toHaveURL(/\/stock\/movements$/);

  const limited = limitedCreds();
  test.skip(!limited, "no limited creds in .env.local");
  await page.context().clearCookies();
  await login(page, limited!);
  await expect(page.getByRole("link", { name: "Stock", exact: true })).toHaveCount(0);
  await page.goto("/stock/finished");
  await expect(page).not.toHaveURL(/\/stock/);
});

test("Record count sets the level, stamps the date and leaves a count movement; a resubmit changes nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, creds!);
  await page.goto("/stock/finished");
  await page.getByRole("button", { name: "Record count" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").selectOption(WAREHOUSE);
  await dialog.locator("textarea").fill(`${SKU},25`);
  await dialog.getByRole("button", { name: "Record count" }).click();
  await expect(page.getByText(/Count recorded for 1 SKU/)).toBeVisible({ timeout: 15_000 });

  await page.reload();
  const row = rowFor(page, WAREHOUSE, SKU);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("25", { exact: true }).first()).toBeVisible();
  await expect(row.getByText("Counted")).toBeVisible();

  // The ledger row behind it, straight from the table.
  const { data: moves } = await sb!.from("stock_movements").select("kind, quantity, balance_after").eq("sku", SKU);
  expect(moves).toEqual([expect.objectContaining({ kind: "count", quantity: 25, balance_after: 25 })]);

  // Same count again, in a fresh dialog (fresh batch id): the level is
  // already 25, so no movement is written and the balance is unchanged.
  await page.getByRole("button", { name: "Record count" }).click();
  const again = page.getByRole("dialog");
  await again.getByRole("combobox").selectOption(WAREHOUSE);
  await again.locator("textarea").fill(`${SKU},25`);
  await again.getByRole("button", { name: "Record count" }).click();
  await expect(page.getByText(/0 levels changed/)).toBeVisible({ timeout: 15_000 });
  const { data: after } = await sb!.from("stock_movements").select("id").eq("sku", SKU);
  expect(after).toHaveLength(1);
});

test("the movements panel opens for a row", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, creds!);
  await page.goto("/stock/finished");
  await rowFor(page, WAREHOUSE, SKU).click();
  await expect(page.getByRole("heading", { name: `${SKU} at ${WAREHOUSE}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Count", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("+25")).toBeVisible();
});

test("Fulfil from stock commits the SRO order, and the first booking deducts it exactly once", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.HUB_EMAIL_TEST_RECIPIENT,
    "HUB_EMAIL_TEST_RECIPIENT is not set: Fulfil from stock would email the real recipient",
  );
  await login(page, creds!);
  await page.goto(`/purchase-orders/${sroPo.id}`);
  await page.getByRole("button", { name: "Fulfil from stock" }).click();
  await expect(page.getByText("Recorded: this order is being fulfilled from SRO stock.")).toBeVisible({ timeout: 15_000 });

  // Committed 10 at EB-SRO, on hand 0: the row exists because the order does.
  await page.goto("/stock/finished");
  const sroRow = rowFor(page, "EB-SRO", SKU);
  await expect(sroRow).toBeVisible({ timeout: 15_000 });
  await expect(sroRow.getByText("10", { exact: true }).first()).toBeVisible();

  // Booking, exactly as the resolver stores it: a po_shipments row with a SPOT id.
  const { error } = await sb!.from("po_shipments").upsert(
    { po_id: sroPo.id, po_number: sroPo.po_number, spot_id: "E2E-SPOT-1", match_count: 1, resolved_at: new Date().toISOString() },
    { onConflict: "po_id" },
  );
  expect(error).toBeNull();

  const { data: shipped } = await sb!
    .from("stock_movements")
    .select("kind, quantity, balance_after, ref_id")
    .eq("sku", SKU)
    .eq("kind", "shipped_out");
  expect(shipped).toEqual([expect.objectContaining({ quantity: -10, balance_after: -10, ref_id: sroPo.id })]);

  // A refresh that re-stores the same spot, and one that changes it: no second deduction.
  await sb!.from("po_shipments").upsert({ po_id: sroPo.id, po_number: sroPo.po_number, spot_id: "E2E-SPOT-1" }, { onConflict: "po_id" });
  await sb!.from("po_shipments").update({ spot_id: "E2E-SPOT-2" }).eq("po_id", sroPo.id);
  const { data: still } = await sb!.from("stock_movements").select("id").eq("sku", SKU).eq("kind", "shipped_out");
  expect(still).toHaveLength(1);

  // The board now shows the deduction, and no commitment (the chain is booked).
  await page.reload();
  const booked = rowFor(page, "EB-SRO", SKU);
  await expect(booked).toBeVisible({ timeout: 15_000 });
  await expect(booked.getByText("-10", { exact: true }).first()).toBeVisible();
});
