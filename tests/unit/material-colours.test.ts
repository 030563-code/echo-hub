import { describe, it, expect } from 'vitest'
import { colourFamilyFor, colourOptionsFor, pickColourOption, toColourOptions } from '@/lib/material-colours'

/**
 * Juraj, 22 Sep 2026: colour options for PC350FR and P200. The bill of materials spells the
 * fabric by roll, the standing specification spells the colour in two languages, and the
 * factory needs one English word on the sheet. These pin how the three meet.
 */
const OPTIONS = toColourOptions({
  PC350FR: ['Black', 'Navy blue', 'Maroon', 'Beige', 'White'],
  P200: ['Flo orange', 'Flo yellow', 'White'],
})

describe('a material finds its colour family by the start of its code', () => {
  it('matches both PC350FR rolls and the bare P200 code, in any case', () => {
    expect(colourFamilyFor('PC350FR-UV21', OPTIONS.keys())).toBe('PC350FR')
    expect(colourFamilyFor('PC350FR-UV15', OPTIONS.keys())).toBe('PC350FR')
    expect(colourFamilyFor('P200', OPTIONS.keys())).toBe('P200')
    expect(colourFamilyFor(' p200fr black ', OPTIONS.keys())).toBe('P200')
  })

  it('takes the longest family when two could start a code', () => {
    expect(colourFamilyFor('PC350FR-UV21', ['PC', 'PC350FR', 'PC350'])).toBe('PC350FR')
  })

  it('answers null for a material that does not come in colours', () => {
    for (const code of ['ACI-T40', 'DAT-01', 'SK-PVC', '', null, undefined]) {
      expect(colourFamilyFor(code, OPTIONS.keys()), String(code)).toBeNull()
    }
  })

  it('hands the editor the options for a fabric and nothing for anything else', () => {
    expect(colourOptionsFor('PC350FR-UV21', OPTIONS)).toEqual(['Black', 'Navy blue', 'Maroon', 'Beige', 'White'])
    expect(colourOptionsFor('P200', OPTIONS)).toEqual(['Flo orange', 'Flo yellow', 'White'])
    expect(colourOptionsFor('DAT-01', OPTIONS)).toEqual([])
    expect(colourOptionsFor('PC350FR-UV21', new Map())).toEqual([])
  })
})

describe('the standing colour becomes an option, or nothing', () => {
  it('reads the bilingual standing colours model_spec holds', () => {
    // As the rows read on 23 Sep 2026: "Čierna/Black" on the PC350FR models, "Oranžová/Orange"
    // on the H10 family, whose fabric is P200.
    expect(pickColourOption('Čierna/Black', OPTIONS.get('PC350FR')!)).toBe('Black')
    expect(pickColourOption('čierna/Black', OPTIONS.get('PC350FR')!)).toBe('Black')
    expect(pickColourOption('Oranžová/Orange', OPTIONS.get('P200')!)).toBe('Flo orange')
    expect(pickColourOption('Biela/White', OPTIONS.get('P200')!)).toBe('White')
  })

  it('prefers an exact option over a word match', () => {
    expect(pickColourOption('white', OPTIONS.get('PC350FR')!)).toBe('White')
    expect(pickColourOption('Navy blue', OPTIONS.get('PC350FR')!)).toBe('Navy blue')
  })

  it('never guesses: a colour that is not an option, or no colour at all, is null', () => {
    expect(pickColourOption('Zelená/Green', OPTIONS.get('PC350FR')!)).toBeNull()
    expect(pickColourOption('Oranžová/Orange', OPTIONS.get('PC350FR')!)).toBeNull()
    expect(pickColourOption(null, OPTIONS.get('PC350FR')!)).toBeNull()
    expect(pickColourOption('   ', OPTIONS.get('PC350FR')!)).toBeNull()
    expect(pickColourOption('Čierna/Black', [])).toBeNull()
  })
})
