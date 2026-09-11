import { describe, it, expect } from 'vitest'
import { parseCountInput } from '@/lib/stock/count-parse'

describe('parseCountInput', () => {
  it('reads comma, semicolon and tab separated lines, upper-casing the sku', () => {
    const { rows, errors } = parseCountInput('ebh9na,25\nEBH10NA;40\nHKNA\t12\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { sku: 'EBH9NA', counted: 25 },
      { sku: 'EBH10NA', counted: 40 },
      { sku: 'HKNA', counted: 12 },
    ])
  })

  it('skips a header row and blank lines', () => {
    const { rows, errors } = parseCountInput('sku,quantity\n\nEBH9NA,25\n\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([{ sku: 'EBH9NA', counted: 25 }])
  })

  it('strips quotes a spreadsheet export adds', () => {
    expect(parseCountInput('"EBH9NA","25"').rows).toEqual([{ sku: 'EBH9NA', counted: 25 }])
  })

  it('reports every problem with its line number and keeps going', () => {
    const { rows, errors } = parseCountInput('EBH9NA,25\nEBH10NA,abc\n,7\nHKNA,-1\nHKNA\nEBH9NA,30')
    expect(rows).toEqual([{ sku: 'EBH9NA', counted: 25 }])
    expect(errors).toEqual([
      { line: 2, message: 'EBH10NA: "abc" is not a number' },
      { line: 3, message: 'No SKU on this line' },
      { line: 4, message: 'HKNA: a count cannot be negative' },
      { line: 5, message: 'HKNA: no quantity' },
      { line: 6, message: 'EBH9NA: already counted on line 1' },
    ])
  })

  it('accepts a zero count, which is a real count', () => {
    expect(parseCountInput('EBH9NA,0').rows).toEqual([{ sku: 'EBH9NA', counted: 0 }])
  })

  it('accepts a fractional count for a material', () => {
    expect(parseCountInput('PC350FR-UV21,142.5').rows).toEqual([{ sku: 'PC350FR-UV21', counted: 142.5 }])
  })
})
