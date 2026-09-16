import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * An email that quietly does not send is worse than one that errors.
 *
 * 16 Sep 2026: a Group-to-SRO leg was approved on production. The Xero workflow
 * fired, the approval looked clean, and the email telling SRO the order was
 * waiting never left the Hub, because decide-po only surfaced reason "failed"
 * and a missing webhook URL returns "not_configured". Dean had to ask whether
 * Juraj had been emailed.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('a purchase order approval says when SRO were not emailed', () => {
  const src = code('src/app/actions/purchase-orders/decide-po.ts')

  it('warns on every non-send except the staging sandbox', () => {
    expect(src).toContain('!notified.sent && notified.reason !== "staging"')
    // The old rule, which let a missing webhook pass silently.
    expect(src).not.toContain('notified.reason === "failed"')
  })

  it('names a missing webhook as its own case, so it is actionable', () => {
    expect(src).toContain('notified.reason === "not_configured"')
    expect(read('src/app/actions/purchase-orders/decide-po.ts')).toContain('SRO were NOT emailed')
  })

  it('still never undoes an approval over an email', () => {
    const notify = code('src/app/actions/purchase-orders/notify-sro.ts')
    // The send is best effort and returns a reason; it never throws.
    expect(notify).toContain("reason: 'not_configured'")
    expect(notify).toContain("reason: 'failed'")
    expect(notify).toContain("reason: 'staging'")
  })
})
