import { describe, it, expect } from 'vitest'
import { formatMoney } from '@/lib/utils'

/**
 * The on-screen money formatter. Moved out of quote-money.test.ts when the
 * jsPDF quote was retired: these assertions protect what a rep reads in the
 * builder and on the deal lists, which has nothing to do with the PDF that
 * file was named after.
 */
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
