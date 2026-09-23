import { describe, expect, it } from 'vitest'
import { cleanReference, looksLikeSpotId, matchesSearch, sheetReferenceList, spotIdsToRefresh } from '@/lib/cargo/references'

/**
 * Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?" These
 * are the rules the board, the actions and the scheduled refresh share. Invented numbers only: the
 * repository is public.
 */

describe('what counts as a SPOT ID', () => {
  it('is digits only, as Cargo Partner issues them', () => {
    expect(looksLikeSpotId('123456789')).toBe(true)
    expect(looksLikeSpotId(' 123456789 ')).toBe(true)
    // An eight digit one is still tried: it may be real, or a typo Cargo Partner will refuse.
    expect(looksLikeSpotId('12345678')).toBe(true)
  })

  it('is not an order reference or a container number', () => {
    expect(looksLikeSpotId('PO-00000001')).toBe(false)
    expect(looksLikeSpotId('ABCU1234567')).toBe(false)
    expect(looksLikeSpotId('12345')).toBe(false)
  })
})

describe('a reference as typed', () => {
  it('is trimmed and keeps single spaces', () => {
    expect(cleanReference('  PO  1234 ')).toBe('PO 1234')
  })

  it('is refused when empty or longer than 80 characters', () => {
    expect(cleanReference('   ')).toBeNull()
    expect(cleanReference('x'.repeat(81))).toBeNull()
    expect(cleanReference('x'.repeat(80))).toBe('x'.repeat(80))
  })
})

describe("the shipping sheet's order numbers", () => {
  it('come once each, order number before the local one, blanks dropped', () => {
    // The sheet has one row per barrier type, so one container repeats its order numbers.
    expect(
      sheetReferenceList([
        { order_no: 'EBG00001', order_no_local: 'USA00001' },
        { order_no: 'EBG00001', order_no_local: null },
        { order_no: ' ', order_no_local: 'USA00002' },
      ]),
    ).toEqual(['EBG00001', 'USA00001', 'USA00002'])
  })
})

describe('the scheduled refresh', () => {
  it('asks only about shipments still moving, and every one not stored yet', () => {
    expect(spotIdsToRefresh(['111', '222', '333'], new Set(['222']))).toEqual(['111', '333'])
    expect(spotIdsToRefresh([], new Set())).toEqual([])
  })
})

describe('the board search', () => {
  const row = {
    spotId: '123456789',
    generalReference: null,
    vesselName: 'SOME VESSEL',
    oceanCarrier: null,
    destinationCity: 'Jessup',
    destinationDepot: 'US-BAL',
    cargoDescription: 'Acoustic Barriers',
    containerNumbers: ['ABCU1234567'],
    references: ['PO 1234', 'EBG00001'],
  }

  it('finds a shipment by a reference typed on it or taken from the sheet', () => {
    expect(matchesSearch(row, 'po 1234')).toBe(true)
    expect(matchesSearch(row, 'ebg00001')).toBe(true)
  })

  it('still finds it by SPOT ID and container, and shows everything for an empty box', () => {
    expect(matchesSearch(row, '123456')).toBe(true)
    expect(matchesSearch(row, 'abcu')).toBe(true)
    expect(matchesSearch(row, '  ')).toBe(true)
    expect(matchesSearch(row, 'nothing like it')).toBe(false)
  })
})
