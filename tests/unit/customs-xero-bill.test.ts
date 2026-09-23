import { describe, expect, it } from 'vitest'
import { allocate, buildXeroBill, depotFromDelivery, NIPPON_CONTACT, type GroupBill } from '@/lib/customs/xero-bill'
import { chargeLabel, customsPackageSchema } from '@/lib/customs/nippon-invoice'
import { PACKAGE_D0806, PACKAGE_D1518, PACKAGE_D8400 } from '../fixtures/customs/nippon-packages'

/**
 * Dean, 23 Sep 2026: the Customs tab "prefills what we need to fill in the same as it currently is
 * under Bills in Xero". The Group bills below are real, as they stand in Echo Barrier USA LLC.
 */

const GROUP_BILLS: GroupBill[] = [
  {
    number: 'EBGS202610039',
    lines: [
      { description: 'Echo Barrier H9', amount: 54125.5, accountCode: '07-0150' },
      { description: 'Packing', amount: 1677.92, accountCode: '07-0150' },
      { description: 'Shipping jessop', amount: 6572, accountCode: '07-0150' },
      { description: 'Cargo Insurance', amount: 136, accountCode: '07-0150' },
    ],
  },
  { number: 'EBGS202610040', lines: [{ description: 'Compact Cutting Station', amount: 1515.86, accountCode: '07-0152' }] },
  {
    number: 'EBUK2026095',
    lines: [
      { description: 'Echo barrier H9X', amount: 6311, accountCode: '07-0154' },
      { description: 'H9X Freight', amount: 764.38, accountCode: '07-0154' },
      { description: 'Full Size Cutting Station', amount: 9681.03, accountCode: '07-0152' },
      { description: 'FSC Freight', amount: 1446.86, accountCode: '07-0152' },
      { description: 'FSC Cartes', amount: 741, accountCode: '07-0152' },
      { description: 'Compact Cutting Station', amount: 7139.43, accountCode: '07-0152' },
      { description: 'COmpact freight', amount: 1446.86, accountCode: '07-0152' },
      { description: 'Compact Crates', amount: 741, accountCode: '07-0152' },
      { description: 'V2', amount: 7168, accountCode: '07-0153' },
      { description: 'Freight V2', amount: 964.57, accountCode: '07-0153' },
      { description: 'Crates V2', amount: 494, accountCode: '07-0153' },
    ],
  },
  {
    number: 'EBGS202610015',
    lines: [
      { description: 'H9', amount: 49728, accountCode: '07-0156' },
      { description: 'Packing', amount: 1468, accountCode: '07-0156' },
      { description: 'Delivery', amount: 4950, accountCode: '07-0156' },
      { description: 'Insurance', amount: 147, accountCode: '07-0156' },
    ],
  },
]

const parse = (raw: unknown) => customsPackageSchema.parse(raw)
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100

describe('allocate', () => {
  it('shares to the cent and leaves the rounding on the largest share', () => {
    expect(allocate(270.2, [55803, 1516])).toEqual([263.05, 7.15])
    expect(allocate(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33])
    expect(sum(allocate(14510.47, [6311, 18302.46, 7662]))).toBe(14510.47)
  })
})

describe('the depot from the delivery address', () => {
  it('knows Jessup is Baltimore and Rancho Cucamonga is San Bernardino', () => {
    expect(depotFromDelivery('CAPITOL EXPRESS, 8125 STAYTON DRIVE, JESSUP, MD 20794')).toBe('US-BAL')
    expect(depotFromDelivery('DLY 3PL, 9138 PITTSBURG AVENUE, RANCHO CUCAMONGA, CA 91730')).toBe('US-SBD')
    expect(depotFromDelivery(null)).toBeNull()
  })
})

describe('the bill, as Dave enters it', () => {
  it('D8400 comes out exactly as Dave keyed it: one line, 9,504.32, to ICA H9 San B', () => {
    const bill = buildXeroBill(parse(PACKAGE_D8400), GROUP_BILLS)
    expect(bill).toMatchObject({
      contactId: NIPPON_CONTACT.id,
      invoiceNumber: '26NEU-445-D8400',
      date: '2026-04-30',
      dueDate: '2026-04-30',
      currency: 'USD',
      lineAmountTypes: 'NoTax',
      total: 9504.32,
      notes: [],
    })
    expect(bill.lines).toEqual([
      { description: 'Duty EBGS202610015', quantity: 1, unitAmount: 9504.32, accountCode: '07-0156', taxType: 'NONE' },
    ])
  })

  it('D1518 gives each Group invoice its duty, and codes the cutting station to its own account', () => {
    const bill = buildXeroBill(parse(PACKAGE_D1518), GROUP_BILLS)
    expect(bill.lines.map((l) => [l.description, l.unitAmount, l.accountCode])).toEqual([
      ['Duty EBGS202610039, TCNU6880423', 6232.77, '07-0150'],
      // Dave coded this one to 07-0156 (ICA H9 San B) by hand; the Group bill sits on 07-0152.
      ['Duty EBGS202610040, TCNU6880423', 169.33, '07-0152'],
    ])
    expect(bill.total).toBe(6402.1)
    expect(bill.notes).toEqual([])
  })

  it("D0806 folds the handling in as Dave does, 14,510.47 across the invoice's three accounts, and lines up exam and drayage apart", () => {
    const bill = buildXeroBill(parse(PACKAGE_D0806), GROUP_BILLS)
    const duty = bill.lines.filter((l) => l.description.startsWith('Duty EBUK2026095'))
    // Dave's own duty lines on this bill add up to the same 14,510.47.
    expect(sum(duty.map((l) => l.unitAmount))).toBe(14510.47)
    // Split by the goods and their crates (the dutiable value), freight left out: 6,311 of H9X,
    // 18,302.46 of cutting stations, 7,662 of V2.
    expect(duty.map((l) => [l.accountCode, l.unitAmount])).toEqual([
      ['07-0154', 2837.31],
      ['07-0152', 8228.46],
      ['07-0153', 3444.7],
    ])
    expect(bill.lines.filter((l) => !l.description.startsWith('Duty')).map((l) => [l.description, l.unitAmount, l.accountCode])).toEqual([
      ['Container drayage', 725, '07-5232'],
      ['Chassis usage charge', 110, '07-5210'],
      ['Demurrage/detention', 1141.25, '07-5210'],
      ['Processing fee', 73.94, '07-5210'],
    ])
    expect(bill.total).toBe(16560.66)
    expect(bill.notes.join(' ')).toMatch(/split by the value of each product/)
  })

  it('says so when a Group invoice is not in Xero, rather than guessing an account', () => {
    const bill = buildXeroBill(parse(PACKAGE_D1518), GROUP_BILLS.filter((b) => b.number !== 'EBGS202610040'))
    expect(bill.lines[1]).toMatchObject({ accountCode: null, unitAmount: 169.33 })
    expect(bill.notes).toEqual([expect.stringMatching(/EBGS202610040 was not found/)])
    expect(bill.total).toBe(6402.1)
  })

  it('without an entry summary, one duty line for Dave to code', () => {
    const raw = JSON.parse(JSON.stringify(PACKAGE_D1518)) as Record<string, unknown>
    raw.entry = null
    const bill = buildXeroBill(parse(raw), GROUP_BILLS)
    expect(bill.lines).toEqual([
      { description: 'Duty EBGS202610040, TCNU6880423', quantity: 1, unitAmount: 6402.1, accountCode: null, taxType: 'NONE' },
    ])
    expect(bill.notes).toEqual([expect.stringMatching(/no entry summary/)])
  })
})

describe('chargeLabel', () => {
  it("writes Nippon's capitals normally and keeps the initials", () => {
    expect(chargeLabel('ISF FILING CHARGE')).toBe('ISF filing charge')
    expect(chargeLabel('DEMURRAGE/DETENTION')).toBe('Demurrage/detention')
    expect(chargeLabel('FORWARDING & HANDLING CHG')).toBe('Forwarding & handling chg')
    // A word that merely starts with initials is left alone.
    expect(chargeLabel('CHASSIS USAGE CHARGE')).toBe('Chassis usage charge')
  })
})
