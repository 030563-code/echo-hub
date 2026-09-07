import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Runs the FULL e2e suite against a DEPLOYED site (E2E_BASE_URL) — the pre-tester
// sweep. Staging shares the prod Supabase, so the _setup.mjs fixtures appear on
// the deployed UI too; specs that need LIVE external calls (Cargo) or mfg writes
// (BOM price save) self-skip on remote — the staging kill switch blocks those by
// design. po-approve-chain is excluded here because staging-smoke.spec.ts already
// covers the approve chain on staging (and localhost approvals are n8n-live).
try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — specs self-skip without creds */
}

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /po-approve-chain\.spec\.ts/,
  fullyParallel: false,
  workers: 2, // deployed target — keep concurrency low, latency is the bottleneck
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, ignoreHTTPSErrors: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
