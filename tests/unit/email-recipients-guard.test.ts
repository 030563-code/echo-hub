import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every Hub action that hands work to n8n has to say what happens to the email.
 *
 * The test-recipient switch in src/lib/email-recipients.ts is only worth having
 * if nothing can go round it. The failure it guards against is not today's
 * code, it is the fourth email, written in three months by whoever, that quietly
 * posts a real supplier address to a webhook while everybody believes the
 * override is on.
 *
 * So a file under src/app/actions that reads a *_WEBHOOK_URL must either call
 * resolveRecipients, or carry one line saying why it does not:
 *
 *   // email-recipients: none   (Xero PO creation, no mail)
 *   // email-recipients: legacy (INVOICE_EMAIL_TEST_RECIPIENT, its own override)
 *
 * Modelled on hubspot-write-guard.test.ts and page-state-guard.test.ts, which
 * do the same job for HubSpot mutations and for page state.
 */

const ROOT = join(process.cwd(), 'src/app/actions')

/** Any env var whose name ends in _WEBHOOK_URL: the way out of this process. */
const POSTS_TO_WEBHOOK = /process\.env\.[A-Z0-9_]*WEBHOOK_URL\b/
const USES_HELPER = /\bresolveRecipients\b/
const MARKER = /\/\/\s*email-recipients:\s*(none|legacy)\b/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('no Hub action can email anybody without going through the test switch', () => {
  const files = walk(ROOT)

  it('finds the action files and the known webhook callers, so a bad path cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(20)
    const callers = files.filter((f) => POSTS_TO_WEBHOOK.test(readFileSync(f, 'utf8')))
    expect(callers.length).toBeGreaterThan(2)
    expect(callers.some((f) => f.endsWith('email-invoice.ts'))).toBe(true)
  })

  it('leaves no webhook caller undeclared', () => {
    const undeclared = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      if (!POSTS_TO_WEBHOOK.test(source)) return false
      if (USES_HELPER.test(source)) return false
      return !MARKER.test(source)
    })

    expect(
      undeclared.map((f) => f.replace(`${process.cwd()}/`, '')),
      'These actions post to an n8n webhook without saying who the email reaches. ' +
        'Either resolve the addresses through resolveRecipients() in ' +
        '@/lib/email-recipients, or add a one-line marker saying why not: ' +
        '// email-recipients: none (reason)',
    ).toEqual([])
  })
})
