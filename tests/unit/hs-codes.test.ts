import { describe, it, expect } from 'vitest'
import {
  HS_CODE_MAX_DIGITS,
  HS_CODE_MIN_DIGITS,
  isValidHsCode,
  issueBlockedReason,
  missingHsCodeLines,
  nameProducts,
  normaliseHsCode,
} from '@/lib/hs-codes'

describe('normaliseHsCode', () => {
  it('trims and collapses whitespace to single spaces', () => {
    expect(normaliseHsCode('  3926.90  ')).toBe('3926.90')
    expect(normaliseHsCode('3926   90\t97')).toBe('3926 90 97')
    expect(normaliseHsCode('\n3926 90\n')).toBe('3926 90')
  })

  it('turns null, undefined and blanks into an empty string', () => {
    expect(normaliseHsCode(null)).toBe('')
    expect(normaliseHsCode(undefined)).toBe('')
    expect(normaliseHsCode('   ')).toBe('')
  })
})

describe('isValidHsCode', () => {
  it('accepts the three formats Juraj uses', () => {
    expect(isValidHsCode('3926.90')).toBe(true)
    expect(isValidHsCode('3926 90 97')).toBe(true)
    expect(isValidHsCode('3926.90.9985')).toBe(true)
  })

  it('accepts plain digits from 6 to 10 long', () => {
    expect(HS_CODE_MIN_DIGITS).toBe(6)
    expect(HS_CODE_MAX_DIGITS).toBe(10)
    expect(isValidHsCode('392690')).toBe(true)
    expect(isValidHsCode('3926909985')).toBe(true)
  })

  it('refuses letters and any other character', () => {
    for (const code of ['3926.9A', 'HS392690', '3926-90', '3926,90', '3926/90', '3926_90']) {
      expect(isValidHsCode(code), code).toBe(false)
    }
  })

  it('refuses too few or too many digits', () => {
    expect(isValidHsCode('39269')).toBe(false)
    expect(isValidHsCode('3926.9')).toBe(false)
    expect(isValidHsCode('39269099851')).toBe(false)
    expect(isValidHsCode('3926.90.99851')).toBe(false)
  })

  it('refuses double separators', () => {
    for (const code of ['3926..90', '3926  90', '3926. 90', '3926 .90']) {
      expect(isValidHsCode(code), code).toBe(false)
    }
  })

  it('refuses a leading or trailing separator', () => {
    for (const code of ['.392690', ' 392690', '392690.', '392690 ']) {
      expect(isValidHsCode(code), code).toBe(false)
    }
  })

  it('refuses an empty string and whitespace other than a single space', () => {
    expect(isValidHsCode('')).toBe(false)
    expect(isValidHsCode('3926\t90')).toBe(false)
  })

  it('accepts what normalising makes of untidy input', () => {
    expect(isValidHsCode(normaliseHsCode('  3926   90 97 '))).toBe(true)
  })
})

describe('missingHsCodeLines', () => {
  it('returns the lines with a null, missing or blank code, in order', () => {
    const lines = [
      { sku: 'A', hs_code: '3926.90' },
      { sku: 'B', hs_code: null },
      { sku: 'C', hs_code: '   ' },
      { sku: 'D', hs_code: '' },
      { sku: 'E', hs_code: undefined },
    ]
    expect(missingHsCodeLines(lines).map((l) => l.sku)).toEqual(['B', 'C', 'D', 'E'])
  })

  it('is empty when every line has a code', () => {
    expect(missingHsCodeLines([{ hs_code: '3926.90' }, { hs_code: '3926 90 97' }])).toEqual([])
  })
})

describe('nameProducts and issueBlockedReason', () => {
  it('names each product once, with its SKU', () => {
    expect(
      nameProducts([
        { sku: 'EBH9NA', product_name: 'Echo Barrier H9' },
        { sku: 'EBH9NA', product_name: 'Echo Barrier H9' },
        { sku: 'X1', product_name: null },
        { sku: 'X2', product_name: 'X2' },
      ]),
    ).toBe('Echo Barrier H9 (EBH9NA), X1, X2')
  })

  it('gives no reason when every line has a code', () => {
    expect(issueBlockedReason([{ sku: 'A', product_name: 'A', hs_code: '3926.90' }])).toBeNull()
  })

  it('names the products that block issuing', () => {
    const reason = issueBlockedReason([
      { sku: 'EBH9NA', product_name: 'Echo Barrier H9', hs_code: null },
      { sku: 'CCSNA', product_name: 'Compact Cutting Station', hs_code: '3926.90' },
      { sku: 'M1NA', product_name: 'M1 Mini Gen Set', hs_code: ' ' },
    ])
    expect(reason).toContain('cannot be issued')
    expect(reason).toContain('2 lines have no HS code')
    expect(reason).toContain('Echo Barrier H9 (EBH9NA)')
    expect(reason).toContain('M1 Mini Gen Set (M1NA)')
    expect(reason).not.toContain('CCSNA')
    expect(reason).not.toContain('\u2014')
  })
})
