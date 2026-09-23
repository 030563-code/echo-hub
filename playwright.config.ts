import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env.local into process.env so specs can read E2E_USERNAME / E2E_PASSWORD
// (and the dev server it starts inherits the Supabase keys). Manual parse — no
// dotenv dependency.
//
// A value written as KEY="value" or KEY='value' is the value without the
// quotes, as the shell and Next's own loader read it. Until 23 Sep 2026 this
// parser kept them, so a quoted password was typed into the login form with
// its quotes and every spec for that persona failed at "Invalid login
// credentials" while the same credentials signed in everywhere else.
const unquote = (value: string) =>
  value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value
try {
  const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = unquote(m[2])
  }
} catch {
  // no .env.local — specs that need creds will fail with a clear message
}

/**
 * The dev server's port, overridable.
 *
 * Phase A made the specs use relative paths so they no longer hardcoded 3000,
 * but this file still did, which is the half that actually decides. Docker
 * holds 3000 on this machine, so `E2E_BASE_URL=http://localhost:3001 npx
 * playwright test` runs the suite against a server that is already up.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
