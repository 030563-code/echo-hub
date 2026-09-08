import { test, expect } from "@playwright/test";
import { adminCreds, login } from "./helpers";
import { deletePurchaseOrdersByNotes, serviceClient } from "./db-helpers";

// Drives the ATOMIC approval chain (hub_approve_po_leg RPC, 2026-07-14) through
// the real UI: raise a depot PO → approve tier 1 → the Group leg appears WITH a
// reference → approve tier 2 → the SRO leg leaves the queue and NOTHING is
// raised in its place. Since 8 Sep 2026 approving the SRO leg mints no Bamida
// order: the order waits on /purchase-orders/<id> for SRO to choose stock or
// manufacture, and this spec ends on that page with both buttons on screen. The
// exact reference values (child.reference_po_number === parent.po_number) are
// asserted DB-side at the end.
//
// SAFETY: approvals hand off to n8n (the Xero PO, and the SRO notification).
// Run this spec ONLY while those workflows are inactive or unpublished, so the
// hand-offs 404 and the approval records "did not confirm". No email can leave.
//
// Every row of the chain carries MARKER in its notes and is deleted in afterAll.

const MARKER = "E2E-APPROVE-CHAIN-MARKER do-not-keep";
const sb = serviceClient();

test.afterAll(async () => {
  if (sb) await deletePurchaseOrdersByNotes(sb, MARKER);
});

test("PO approve chain: raise → tier1 → tier2(ref) → SRO decides", async ({ page }) => {
  test.setTimeout(150_000);
  const c = adminCreds();
  test.skip(!c, "no admin creds in .env.local");
  test.skip(!sb, "no service-role key in .env.local");
  await login(page, c!);

  // ---- raise a US-BAL root PO with the marker note ----
  await page.goto("/purchase-orders/create");
  await page.locator('select[required]').first().selectOption("US-BAL");
  // Delivery address is required — pick the first real ship-to option.
  await page.locator('select[required]').nth(1).selectOption({ index: 1 });
  await page.locator("select").filter({ hasText: "Select product…" }).first().selectOption("EBH9NA");
  await page.getByLabel("Quantity").fill("7");
  await page.getByLabel("Unit price").fill("106");
  await page.getByPlaceholder("Anything EB Group should know about this order…").fill(MARKER);
  await page.getByRole("button", { name: "Raise PO for approval" }).click();
  await expect(page.getByText("Purchase order raised").first()).toBeVisible({ timeout: 15_000 });

  // Target each tier's card by its ROUTE text: the from → to pair is the
  // unambiguous anchor, and the auto-retrying visibility waits ride through
  // router.refresh.
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

  // ---- the SRO leg leaves the queue, and no Bamida order is minted for it ----
  await expect(t2).toBeHidden({ timeout: 25_000 });
  await expect(t3).toHaveCount(0);

  const { data: sroLeg } = await sb!
    .from("purchase_orders")
    .select("id, po_number, reference_po_number, parent_po_id")
    .eq("notes", MARKER)
    .eq("leg", "EB_GROUP_TO_SRO")
    .maybeSingle();
  expect(sroLeg).not.toBeNull();
  const { data: groupLeg } = await sb!
    .from("purchase_orders")
    .select("po_number")
    .eq("id", sroLeg!.parent_po_id)
    .single();
  expect(groupLeg).not.toBeNull();
  expect(sroLeg!.reference_po_number).toBe(groupLeg!.po_number);
  const { count } = await sb!
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("parent_po_id", sroLeg!.id);
  expect(count).toBe(0);

  // ---- the order now waits on SRO's decision, and both choices are on screen ----
  await page.goto(`/purchase-orders/${sroLeg!.id}`);
  await expect(page.getByRole("heading", { name: "How is this order being fulfilled?" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Fulfil from stock" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manufacture", exact: true })).toBeEnabled();
});
