import { describe, it, expect } from 'vitest'
import { packingSize, palletFootprint, palletHeight } from '@/lib/despatch/packing-size'

/**
 * Every Pallet type and Pallet height value model_spec held on 21 Sep 2026,
 * verbatim. The parser has to read all of them and invent nothing for the ones
 * that name no size.
 */

describe('the pallet footprint', () => {
  it.each([
    ['FYTO/210x140 a', '210 x 140 cm'],
    ['FYTO/210x140', '210 x 140 cm'],
    ['210x140cm FYTO', '210 x 140 cm'],
    ['210x140 Fyto', '210 x 140 cm'],
    ['FYTO/označená', null],
    ['označená', null],
    ['', null],
    [null, null],
  ])('reads %j as %j', (input, expected) => {
    expect(palletFootprint(input)).toBe(expected)
  })

  it('does not read a millimetre pallet as centimetres', () => {
    expect(palletFootprint('EUR 1200x800')).toBeNull()
  })
})

describe('the pallet height', () => {
  it.each([
    ['MAX výška palety 235 cm !!!', 'height 235 cm'],
    ['MAX výška palety 245 cm !!!', 'height 245 cm'],
    ['MAX výška palety 230 cm !!!', 'height 230 cm'],
    ['štitky : MAX výška palety 245 cm !!!', 'height 245 cm'],
    ['', null],
    [null, null],
  ])('reads %j as %j', (input, expected) => {
    expect(palletHeight(input)).toBe(expected)
  })
})

describe('the printed packing size', () => {
  it('prints both halves the way their documents do', () => {
    expect(packingSize('210x140cm FYTO', 'MAX výška palety 235 cm !!!').text).toBe('210 x 140 cm / height 235 cm')
  })

  it('prints the height alone when the type names no size, and says which half is missing', () => {
    expect(packingSize('FYTO/označená', 'MAX výška palety 245 cm !!!')).toEqual({
      text: 'height 245 cm',
      footprint: null,
      height: 'height 245 cm',
    })
  })

  it('is null when neither row says anything', () => {
    expect(packingSize('označená', null)).toEqual({ text: null, footprint: null, height: null })
  })

  it('never lends the H9 pallet to a model that has none written down', () => {
    for (const type of ['FYTO/označená', 'označená', null]) {
      expect(packingSize(type, 'MAX výška palety 245 cm !!!').text).not.toContain('210')
    }
  })
})
