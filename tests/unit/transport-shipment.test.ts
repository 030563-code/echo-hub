import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  containerList,
  containerNumber,
  contentsSummary,
  handProgress,
  lineReferences,
  lineRows,
  linesFromSheet,
  localOrderLabel,
  productCodeFor,
  shipmentLinesSchema,
  suggestedPallets,
  type DepotProductOption,
  type HubShipment,
} from '@/lib/transport/shipment'
import { boardItems, handItem } from '@/lib/transport/board'
import { matchesSearch } from '@/lib/cargo/references'
import type { CargoBoardRow } from '@/lib/cargo/store'

/**
 * Dean, 24 Sep 2026: shipments kept by hand, and what is on every shipment. Invented numbers
 * throughout: the repository is public.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

const PRODUCTS: DepotProductOption[] = [
  { code: 'H9BALT', description: 'Echo Barrier H9', family: 'H9' },
  { code: 'H9W', description: 'Echo Barrier H9 white', family: 'H9' },
  { code: 'H10HERCB', description: 'Echo Barrier H10 HERC', family: 'H10' },
  { code: 'H8BALT', description: 'Echo Barrier H8', family: 'H8' },
  { code: 'CS1BALT', description: 'Cutting station', family: 'Cutting Station' },
]

describe('a container number', () => {
  it('is four letters and seven digits, spaces dropped', () => {
    expect(containerNumber('abcu1234567')).toBe('ABCU1234567')
    expect(containerNumber('ABCU 1234567')).toBe('ABCU1234567')
    expect(containerNumber('ABC1234567')).toBeNull()
    expect(containerNumber('ABCU123456')).toBeNull()
  })

  it('comes as a list typed in one box, each once, and a bad one is named', () => {
    expect(containerList('ABCU1234567, zzzu7654321;ABCU1234567')).toEqual({ ok: true, numbers: ['ABCU1234567', 'ZZZU7654321'] })
    expect(containerList('  ')).toEqual({ ok: true, numbers: [] })
    expect(containerList('ABCU1234567, not one')).toEqual({ ok: false, bad: 'not one' })
  })
})

describe('the pallets a line makes', () => {
  it('is 70 barriers a pallet, 30 for H8, rounded up', () => {
    expect(suggestedPallets('H9', 560)).toBe(8)
    expect(suggestedPallets('H10', 280)).toBe(4)
    expect(suggestedPallets('H9', 71)).toBe(2)
    expect(suggestedPallets('H8', 60)).toBe(2)
  })

  it('is left to a person for anything that is not a barrier, or no quantity', () => {
    expect(suggestedPallets('Cutting Station', 5)).toBeNull()
    expect(suggestedPallets(null, 5)).toBeNull()
    expect(suggestedPallets('H9', 0)).toBeNull()
  })
})

describe("what Dave's sheet calls a barrier type", () => {
  it('is the item code when it already is one', () => {
    expect(productCodeFor('h10hercb', 'US-BAL', PRODUCTS)).toBe('H10HERCB')
  })

  it("is the depot's own item for a plain type, by its naming", () => {
    // Two H9 items at this depot; the naming says which one "H9" is.
    expect(productCodeFor('H9', 'US-BAL', PRODUCTS)).toBe('H9BALT')
    expect(productCodeFor('H8', 'US-BAL', PRODUCTS)).toBe('H8BALT')
  })

  it('is kept as typed when nothing says which item it is', () => {
    expect(productCodeFor('H9', 'US-SBD', PRODUCTS)).toBe('H9')
    expect(productCodeFor('Mystery', 'US-BAL', PRODUCTS)).toBe('Mystery')
  })

  it('becomes lines to start from, with pallets filled for barriers only', () => {
    const lines = linesFromSheet(
      [
        { barrierType: 'H10HERCB', quantity: 140, orderNo: 'EBG00001', orderNoLocal: 'USA00001' },
        { barrierType: 'CS1BALT', quantity: 3, orderNo: null, orderNoLocal: 'USA00001' },
        { barrierType: ' ', quantity: 5, orderNo: null, orderNoLocal: null },
        { barrierType: 'H9', quantity: 0, orderNo: null, orderNoLocal: null },
      ],
      'US-BAL',
      PRODUCTS,
    )
    expect(lines).toEqual([
      {
        id: null,
        productCode: 'H10HERCB',
        description: 'Echo Barrier H10 HERC',
        quantity: 140,
        pallets: 2,
        groupOrderNo: 'EBG00001',
        localOrderNo: 'USA00001',
      },
      {
        id: null,
        productCode: 'CS1BALT',
        description: 'Cutting station',
        quantity: 3,
        pallets: null,
        groupOrderNo: null,
        localOrderNo: 'USA00001',
      },
    ])
  })
})

describe('where a shipment kept by hand is', () => {
  const none = { collectedOn: null, shippedOn: null, etaPort: null, etaDepot: null, deliveredOn: null }

  it('reads its dates from the last one reached', () => {
    expect(handProgress(none)).toEqual({ status: 'Not shipped yet', on: null, isComplete: false, eta: null })
    expect(handProgress({ ...none, collectedOn: '2026-01-02', etaPort: '2026-02-01' })).toEqual({
      status: 'Collected from the factory',
      on: '2026-01-02',
      isComplete: false,
      eta: '2026-02-01',
    })
    expect(handProgress({ ...none, shippedOn: '2026-01-05', etaPort: '2026-02-01', etaDepot: '2026-02-09' }).eta).toBe('2026-02-09')
    expect(handProgress({ ...none, shippedOn: '2026-01-05', deliveredOn: '2026-02-10' })).toEqual({
      status: 'Delivered',
      on: '2026-02-10',
      isComplete: true,
      eta: '2026-02-10',
    })
  })
})

describe('the contents in one line', () => {
  it('names each product, and the pallets once every line has them', () => {
    expect(contentsSummary([])).toBeNull()
    expect(
      contentsSummary([
        { productCode: 'H9BALT', quantity: 140, pallets: 2 },
        { productCode: 'CS1BALT', quantity: 3, pallets: 1 },
      ]),
    ).toBe('140 × H9BALT, 3 × CS1BALT on 3 pallets')
    expect(contentsSummary([{ productCode: 'H9BALT', quantity: 70, pallets: 1 }])).toBe('70 × H9BALT on 1 pallet')
    expect(
      contentsSummary([
        { productCode: 'H9BALT', quantity: 140, pallets: 2 },
        { productCode: 'CS1BALT', quantity: 3, pallets: null },
      ]),
    ).toBe('140 × H9BALT, 3 × CS1BALT')
  })

  it('carries the order numbers each once, Group first', () => {
    expect(
      lineReferences([
        { groupOrderNo: 'EBG00001', localOrderNo: 'USA00001' },
        { groupOrderNo: 'EBG00001', localOrderNo: 'USA00002' },
        { groupOrderNo: null, localOrderNo: null },
      ]),
    ).toEqual(['EBG00001', 'USA00001', 'USA00002'])
  })

  it('names the depot order the way the tab does', () => {
    expect(localOrderLabel('US-BAL')).toBe('USA / Canada order')
    expect(localOrderLabel('CA-HAM')).toBe('USA / Canada order')
    expect(localOrderLabel('EU-FR')).toBe('Depot order')
  })
})

describe('saving the contents', () => {
  const line = { productCode: 'H9BALT', quantity: 140 }

  it('refuses a line with no quantity, a line sent twice, and more than forty', () => {
    expect(shipmentLinesSchema.safeParse([{ ...line, quantity: 0 }]).success).toBe(false)
    const id = '11111111-1111-4111-8111-111111111111'
    expect(shipmentLinesSchema.safeParse([{ ...line, id }, { ...line, id }]).success).toBe(false)
    expect(shipmentLinesSchema.safeParse(Array.from({ length: 41 }, () => line)).success).toBe(false)
    expect(shipmentLinesSchema.safeParse([]).success).toBe(true)
  })

  it('numbers the rows in the order they came, blanks as empty for the database to null', () => {
    const parsed = shipmentLinesSchema.parse([{ ...line, description: '  ', pallets: 2 }, { productCode: ' CS1BALT ', quantity: 3 }])
    expect(lineRows(parsed)).toEqual([
      { id: '', position: 0, product_code: 'H9BALT', description: '', quantity: 140, pallets: 2, group_order_no: '', local_order_no: '' },
      { id: '', position: 1, product_code: 'CS1BALT', description: '', quantity: 3, pallets: '', group_order_no: '', local_order_no: '' },
    ])
  })
})

describe('the board', () => {
  const booked: CargoBoardRow = {
    spotId: '123456789',
    containerNumbers: ['ABCU1234567'],
    generalReference: null,
    vesselName: 'SOME VESSEL',
    oceanCarrier: null,
    originCity: 'Somewhere',
    destinationCity: 'Jessup',
    destinationDepot: 'US-BAL',
    cargoDescription: 'Acoustic Barriers',
    totalPieces: 2,
    pickedUpOn: null,
    departedOn: '2026-01-05',
    eta: '2026-02-09',
    currentStatus: 'Departed',
    currentStatusOn: '2026-01-05',
    currentStatusLocation: 'A port',
    isComplete: false,
    syncedAt: null,
    slipDays: null,
    references: ['EBG00009'],
  }
  const hand: HubShipment = {
    id: '22222222-2222-4222-8222-222222222222',
    spotId: null,
    depot: 'US-BAL',
    containers: [],
    shipper: null,
    bookedOn: null,
    collectedOn: null,
    shippedOn: null,
    etaPort: null,
    etaDepot: '2026-01-20',
    deliveredOn: null,
    notes: null,
    lines: [
      { id: 'a', position: 0, productCode: 'H9BALT', description: null, quantity: 140, pallets: 2, groupOrderNo: null, localOrderNo: 'USA00003' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('puts the shipments kept by hand among the booked ones, by arrival', () => {
    const items = boardItems(
      [booked],
      new Map([['123456789', [{ ...hand.lines[0], localOrderNo: 'USA00004' }]]]),
      [hand, { ...hand, id: '33333333-3333-4333-8333-333333333333', etaDepot: null, lines: [] }],
    )
    expect(items.map((i) => i.key)).toEqual([hand.id, '123456789', '33333333-3333-4333-8333-333333333333'])
    const [first, second] = items
    expect(first).toMatchObject({ byHand: true, spotId: null, totalPieces: 2, contents: '140 × H9BALT on 2 pallets', currentStatus: 'Not shipped yet' })
    // A booked one keeps Cargo Partner's facts and gains the contents and their order numbers.
    expect(second).toMatchObject({ byHand: false, spotId: '123456789', totalPieces: 2, contents: '140 × H9BALT on 2 pallets' })
    expect(second.references).toEqual(['EBG00009', 'USA00004'])
  })

  it('finds a shipment kept by hand by its order number or what is on it', () => {
    const item = handItem(hand)
    expect(matchesSearch(item, 'usa00003')).toBe(true)
    expect(matchesSearch(item, 'h9balt')).toBe(true)
    expect(matchesSearch(item, 'nothing like it')).toBe(false)
  })
})

describe('what the contents loader may carry', () => {
  it('reads only what is on a shipment, never money', () => {
    // 🔴 The landed cost adds prices to these same rows behind cost.view. A price added here would
    // reach everybody who can open Transport.
    const source = read('src/lib/transport/shipments.server.ts')
    const columns = source.match(/export const LINE_COLUMNS = '([^']+)'/)?.[1]
    expect(columns?.split(', ')).toEqual([
      'id',
      'shipment_id',
      'position',
      'product_code',
      'description',
      'quantity',
      'pallets',
      'group_order_no',
      'local_order_no',
    ])
  })

  it('every action asks for Transport and the shipment itself', () => {
    const source = read('src/app/actions/transport/shipments.ts')
    const exported = source.match(/^export async function \w+/gm) ?? []
    expect(exported.length).toBe(5)
    expect((source.match(/await transportScope\(\)/g) ?? []).length).toBe(exported.length)
    // Each write names the shipment's scope before it touches a row.
    expect((source.match(/await hubShipmentInScope\(/g) ?? []).length).toBe(4)
    expect(source).toContain('scope.depots.includes(depot)')
  })
})
