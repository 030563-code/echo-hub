import { describe, it, expect } from 'vitest'
import { buildInvoiceEmail } from '@/lib/customer-invoice/invoice-email'

const base = {
  invoiceNumber: 'EBUS26-0001',
  currency: 'USD',
  total: 1297.13,
  amountDue: 1297.13,
  dueDate: '2026-10-03',
}

describe('buildInvoiceEmail', () => {
  it('renders Dean&apos;s copy exactly', () => {
    const { subject, body } = buildInvoiceEmail(base)
    expect(subject).toBe('Echo Barrier invoice EBUS26-0001')
    expect(body).toBe(
      [
        'Hi there,',
        '',
        "Here's invoice EBUS26-0001 for USD 1,297.13.",
        '',
        'The amount outstanding of USD 1,297.13 is due on October 3, 2026.',
        '',
        'If you have any questions, please let us know.',
        '',
        'Thanks,',
        'Echo Barrier USA LLC',
      ].join('\n'),
    )
  })

  it('greets the person when one is known', () => {
    expect(buildInvoiceEmail({ ...base, contactFirstName: 'Dan' }).body).toContain('Hi Dan,')
  })

  // A Xero contact usually holds only the business name, and
  // "Hi Apex Technology, Inc," reads like a mailshot.
  it('falls back to Hi there rather than a blank or a company name', () => {
    expect(buildInvoiceEmail({ ...base, contactFirstName: '   ' }).body.startsWith('Hi there,')).toBe(true)
  })

  it('always prints two decimals, so an invoice never reads 1,297.1', () => {
    expect(buildInvoiceEmail({ ...base, total: 1297.1, amountDue: 1297.1 }).body)
      .toContain('USD 1,297.10')
    expect(buildInvoiceEmail({ ...base, total: 1200, amountDue: 1200 }).body)
      .toContain('USD 1,200.00')
  })

  // Xero holds no payment terms for some contacts, so due_date is null. Better
  // to drop the sentence than to print "is due on ." at a customer.
  it('drops the due date sentence when there is no due date', () => {
    const body = buildInvoiceEmail({ ...base, dueDate: null }).body
    expect(body).toContain('The amount outstanding is USD 1,297.13.')
    expect(body).not.toContain('is due on')
  })

  it('shows what is still owed separately from the total', () => {
    const body = buildInvoiceEmail({ ...base, total: 1297.13, amountDue: 300 }).body
    expect(body).toContain('Here\'s invoice EBUS26-0001 for USD 1,297.13.')
    expect(body).toContain('The amount outstanding of USD 300.00')
  })

  it('uses the invoice currency, not a hardcoded USD', () => {
    expect(buildInvoiceEmail({ ...base, currency: 'CAD' }).body).toContain('CAD 1,297.13')
  })

  it('never renders a null as the word null', () => {
    const body = buildInvoiceEmail({ invoiceNumber: null, currency: null, total: null, amountDue: null, dueDate: null }).body
    expect(body).not.toContain('null')
    expect(body).toContain('USD 0.00')
  })
})
