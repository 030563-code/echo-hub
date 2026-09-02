import { describe, it, expect } from 'vitest'
import { formatQuoteMoney } from '@/lib/quote-pdf'
import { formatMoney } from '@/lib/utils'

describe('formatQuoteMoney', () => {
  it('defaults to USD, so an omitted currency prints what it always printed', () => {
    expect(formatQuoteMoney(1234.5)).toBe('$1,234.50')
  })

  it('keeps cents, unlike the formatCurrency it replaced', () => {
    expect(formatQuoteMoney(0)).toBe('$0.00')
    expect(formatQuoteMoney(1234.56)).toBe('$1,234.56')
  })

  it('uses a narrow symbol in the line-item table', () => {
    // autoTable sizes those columns itself, so the compact form is safe and
    // reads naturally next to the quantity.
    expect(formatQuoteMoney(1234.56, 'CAD')).toBe('$1,234.56')
  })

  it('uses the unambiguous ISO code in the totals block', () => {
    // "$1,234.56" on a Canadian quote is genuinely ambiguous to the customer
    // reading it. The totals block is the number they act on.
    //
    // Intl separates the code from the number with a NON-BREAKING space
    // (U+00A0), not an ordinary one. Pinned explicitly because the two are
    // indistinguishable on screen, and jsPDF has to render whatever comes out.
    expect(formatQuoteMoney(1234.56, 'CAD', 'code')).toBe('CAD\u00a01,234.56')
    expect(formatQuoteMoney(1234.56, 'USD', 'code')).toBe('USD\u00a01,234.56')
  })

  it('keeps a seven-figure total inside the widened totals column', () => {
    // TOTALS_AMOUNT_WIDTH is 48mm and the labels are right-aligned against it,
    // so an overflowing amount grows leftwards into its own label. At 12pt
    // helvetica bold roughly 2.2mm per character leaves ~21 characters.
    const widest = formatQuoteMoney(9876543.21, 'CAD', 'code')
    expect(widest).toBe('CAD\u00a09,876,543.21')
    expect(widest.length).toBeLessThanOrEqual(21)
  })

  it('is case-insensitive about the currency it is handed', () => {
    expect(formatQuoteMoney(10, 'cad', 'code')).toBe('CAD\u00a010.00')
  })
})

describe('formatMoney (screen)', () => {
  it('formats in the given currency and keeps cents', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50')
    expect(formatMoney(1234.5, 'CAD')).toBe('CA$1,234.50')
  })

  it('renders a dash for a missing amount rather than zero', () => {
    // A blank amount and a genuine zero mean different things on a deal list.
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
    expect(formatMoney(0)).toBe('$0.00')
  })
})
