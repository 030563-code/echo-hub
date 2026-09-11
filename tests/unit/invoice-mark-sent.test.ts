import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "Mark as sent" is the second door out of the documented step.
 *
 * Dean, 11 Sep 2026: some customers do not get the invoice by email, and Send
 * to Xero refuses to run until the Hub records that the customer has it. The
 * action must make exactly the transition the email path makes (documented ->
 * sent, one conditional update) and nothing else: no mail, no PDF render, no
 * emailed_* stamps that would claim an email left the building.
 *
 * Source-grep in the house style (email-recipients-guard, page-state-guard):
 * the action is a thin server action over the admin client and the thing worth
 * pinning is what it touches, which a mocked client would only prove about the
 * mock.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('markInvoiceSent source', () => {
  const SRC = read('src/app/actions/invoicing/mark-sent.ts')

  it('self-check: the file was found and is the action', () => {
    expect(SRC.length).toBeGreaterThan(800)
    expect(SRC).toContain('export async function markInvoiceSent')
  })

  it('is gated like every other invoicing write', () => {
    expect(SRC).toContain('requireInvoicingManage()')
  })

  it('moves documented to sent with ONE conditional update', () => {
    // Single winner: a double click, or a click racing the email button,
    // must leave exactly one transition and tell the loser.
    expect(SRC).toMatch(/status: 'sent'[\s\S]{0,300}\.eq\('status', 'documented'\)[\s\S]{0,80}\.select\('id'\)/)
    expect(SRC).toMatch(/won\.length === 0/)
  })

  it('refuses any status other than documented', () => {
    expect(SRC).toMatch(/invoice\.status !== 'documented'/)
  })

  it('never claims an email was sent', () => {
    // These three columns mean "an email left the Hub". Writing them here would
    // make a hand-delivered invoice indistinguishable from an emailed one. The
    // check reads the update object itself, not the file, because the header
    // comment names the columns while explaining why they are left alone.
    const update = SRC.match(/\.update\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    expect(update.length).toBeGreaterThan(20)
    expect(update).toContain("status: 'sent'")
    expect(update).not.toContain('emailed_')
    expect(SRC).not.toContain('N8N_CUSTOMER_INVOICE_WEBHOOK_URL')
    expect(SRC).not.toContain('renderInvoicePdf')
  })

  it('leaves its own audit row, distinct from the email one', () => {
    expect(SRC).toContain("'invoice_marked_sent'")
    expect(SRC).not.toContain("'invoice_emailed'")
  })
})

describe('invoice editor wiring', () => {
  const EDITOR = read('src/app/(dashboard)/invoicing/[dealId]/invoice-editor.tsx')

  it('offers both doors on the documented step, and only there', () => {
    const documentedBlock = EDITOR.match(/status === 'documented' && \(([\s\S]*?)\n\s*\)\}/)?.[1] ?? ''
    expect(documentedBlock.length).toBeGreaterThan(200)
    expect(documentedBlock).toContain('onMarkSent')
    expect(documentedBlock).toContain('onEmail')
    // Not on sent: once sent, the only way forward is Xero.
    const sentBlock = EDITOR.match(/status === 'sent' && \(([\s\S]*?)\n\s*\)\}/)?.[1] ?? ''
    expect(sentBlock).not.toContain('onMarkSent')
  })
})

describe('Send to Xero gate copy', () => {
  it('names both doors, so a hand-delivered invoice is not told to email', () => {
    const XERO = read('src/app/actions/invoicing/send-to-xero.ts')
    expect(XERO).toMatch(/by email or marked as sent/)
  })
})
