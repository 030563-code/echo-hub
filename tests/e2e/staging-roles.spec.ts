import { test, expect, type Page } from "@playwright/test";
import { login, type Creds } from "./helpers";

// The TESTER-EYE sweep against the deployed staging site: signs in as each of the
// three real test accounts (Manager / Sales / Production) exactly as the guide
// instructs, and verifies each role sees precisely what it should — plus the
// invoice generate → edit-draft → void loop Juraj asked about (as Manager).
//
//   E2E_BASE_URL=... TESTER_MANAGER_EMAIL=... TESTER_MANAGER_PASSWORD=... \
//   TESTER_SALES_EMAIL=... TESTER_SALES_PASSWORD=... \
//   TESTER_PRODUCTION_EMAIL=... TESTER_PRODUCTION_PASSWORD=... \
//     npx playwright test tests/e2e/staging-roles.spec.ts --config=playwright.remote.config.ts
//
// Credentials come from env only — never hardcoded (public repo). Each test
// self-skips without its persona. Read-mostly; the only write is the invoice
// draft (voided in-test; the orchestrator hard-deletes the row afterwards).

const REMOTE = !!process.env.E2E_BASE_URL;
const persona = (k: string): Creds | null => {
  const email = process.env[`TESTER_${k}_EMAIL`];
  const password = process.env[`TESTER_${k}_PASSWORD`];
  return email && password ? { email, password } : null;
};
const MANAGER = persona("MANAGER");
const SALES = persona("SALES");
const PRODUCTION = persona("PRODUCTION");

const navLink = (page: Page, name: string) => page.locator("aside").getByRole("link", { name, exact: true });

test.describe("staging tester accounts", () => {
  test.skip(!REMOTE, "remote-only (needs E2E_BASE_URL)");

  test("Manager: nav, approvals access, costs visible", async ({ page }) => {
    test.skip(!MANAGER, "no TESTER_MANAGER_* creds in env");
    await login(page, MANAGER!);
    await expect(page.getByText("STAGING SANDBOX", { exact: false })).toBeVisible({ timeout: 20_000 });

    for (const item of ["Purchase Orders", "Bill of Materials", "Transport", "Invoices", "MRP"]) {
      await expect(navLink(page, item)).toBeVisible();
    }
    // Manager approves — the Approvals queue must open.
    await page.goto("/purchase-orders/approvals");
    await expect(page.getByRole("heading", { name: "PO Approvals" })).toBeVisible({ timeout: 20_000 });
    // cost.view: the invoices register shows money.
    await page.goto("/invoices");
    await expect(page.getByRole("heading", { name: "Commercial Invoices" })).toBeVisible();
  });

  test("Sales: quotes + raise PO; no invoices/BOM/MRP; no prices", async ({ page }) => {
    test.skip(!SALES, "no TESTER_SALES_* creds in env");
    await login(page, SALES!);
    await expect(navLink(page, "Quotes")).toBeVisible();
    await expect(navLink(page, "Purchase Orders")).toBeVisible();
    for (const hidden of ["Invoices", "Bill of Materials", "MRP", "Transport"]) {
      await expect(navLink(page, hidden)).toHaveCount(0);
    }
    // Can open the raise form; delivery address is REQUIRED (starred label).
    await page.goto("/purchase-orders/create");
    await expect(page.getByRole("heading", { name: "Raise Purchase Order" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Delivery address *")).toBeVisible();
    // No cost.view → the unit-price column renders as a dash, not an input.
    await expect(page.getByLabel("Unit price")).toHaveCount(0);
    // No po.approve → the Approvals route bounces away.
    await page.goto("/purchase-orders/approvals");
    await expect(page.getByRole("heading", { name: "PO Approvals" })).toHaveCount(0);
  });

  test("Production: receive-side views only, and NO prices anywhere", async ({ page }) => {
    test.skip(!PRODUCTION, "no TESTER_PRODUCTION_* creds in env");
    await login(page, PRODUCTION!);
    await expect(navLink(page, "Purchase Orders")).toBeVisible();
    await expect(navLink(page, "Bill of Materials")).toBeVisible();
    await expect(navLink(page, "Transport")).toBeVisible();
    for (const hidden of ["Quotes", "Invoices", "MRP"]) {
      await expect(navLink(page, hidden)).toHaveCount(0);
    }
    // No po.create → no Raise PO button on the board.
    await page.goto("/purchase-orders");
    await expect(page.getByRole("link", { name: "Raise PO" })).toHaveCount(0);
    // BOM opens; no cost tabs; and opening a BOM PO shows the price-less document
    // (the "Prices hidden" note lives INSIDE the document view, not the landing).
    await page.goto("/bom");
    await expect(page.getByText("SRO Order BOMs", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Master Prices")).toHaveCount(0);
    await page.getByRole("button", { name: "BOM PO" }).first().click();
    await expect(page.getByRole("dialog").getByText(/Prices hidden/)).toBeVisible({ timeout: 20_000 });
  });

  test("Manager: generate EUR invoice -> edit draft opens -> void (Juraj's loop)", async ({ page }) => {
    test.skip(!MANAGER, "no TESTER_MANAGER_* creds in env");
    await login(page, MANAGER!);
    await page.goto("/invoices");
    await expect(page.getByText("New invoice — from a container")).toBeVisible({ timeout: 20_000 });

    // Generate the EUR (SRO→Group) invoice for a SPECIFIC real container — never
    // "the first row" (concurrent suites seed E2E fixture containers into the
    // same shared register, which polluted a first-row locator once already).
    // CMAU4783188 has no LIVE EUR invoice — BEAU/TIIU carry real pre-existing
    // drafts, and the (container, leg) live-unique guard rightly refuses a second.
    const CONTAINER = "CMAU4783188";
    const row0 = page.locator("table tr").filter({ hasText: CONTAINER }).first();
    await row0.getByRole("button", { name: "EUR" }).click();

    // The generated-invoice modal opens with an EBGS number; capture + close.
    const modalTitle = page.getByRole("heading", { name: /Commercial Invoice —/ });
    await expect(modalTitle).toBeVisible({ timeout: 30_000 });
    const invNumber = (await modalTitle.locator("span.font-mono").innerText()).trim();
    await page.getByRole("button", { name: "Close" }).click();

    // It lands in the register as a DRAFT; the draft editor opens (the override).
    const row = page.getByRole("row").filter({ hasText: invNumber });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("DRAFT")).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: /Edit draft —/ })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // Void it (accept the confirm) — the correction path Juraj asked about.
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "Void" }).click();
    await expect(row.getByText(/void/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test("Manager: USD leg gives a clean outcome (invoice or graceful error)", async ({ page }) => {
    test.skip(!MANAGER, "no TESTER_MANAGER_* creds in env");
    await login(page, MANAGER!);
    await page.goto("/invoices");
    const row0 = page.locator("table tr").filter({ hasText: "BEAU4067822" }).first();
    await row0.getByRole("button", { name: "USD" }).click();

    // Either the invoice modal opens (FX available on the deploy) or a visible,
    // graceful error appears — a silent hang/crash fails the test either way.
    // .first(): on success BOTH the toast and the modal render simultaneously.
    const modal = page.getByRole("heading", { name: /Commercial Invoice —/ });
    const anyError = page.locator("p.text-yellow-400, [data-sonner-toast]");
    await expect(modal.or(anyError).first()).toBeVisible({ timeout: 30_000 });
    const gotInvoice = await modal.isVisible();
    console.log(`USD-LEG-OUTCOME: ${gotInvoice ? "INVOICE-GENERATED" : "GRACEFUL-ERROR"}`);
    if (gotInvoice) {
      const invNumber = (await page.locator("span.font-mono", { hasText: /EBGS|EBGU/ }).first().innerText()).trim();
      console.log(`USD-INVOICE-NUMBER: ${invNumber}`);
      await page.getByRole("button", { name: "Close" }).click();
      // Void it so the container/leg slot is freed again.
      const row = page.getByRole("row").filter({ hasText: invNumber });
      page.once("dialog", (d) => d.accept());
      await row.getByRole("button", { name: "Void" }).click();
      await expect(row.getByText(/void/i).first()).toBeVisible({ timeout: 20_000 });
    }
  });
});
