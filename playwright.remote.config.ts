import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Runs specs against a DEPLOYED site (E2E_BASE_URL), no local webServer. Used to
// verify the Netlify staging deploy. Loads .env.local for the E2E_* login creds.
try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — the spec self-skips without creds */
}

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /staging-(remote|smoke)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL, ignoreHTTPSErrors: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
