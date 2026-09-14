import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  INVOICE_LEGS,
  LEG_CONFIG,
  currencySymbol,
  isInvoiceLeg,
  legLabel,
  legsForDestination,
} from '@/lib/invoice-legs'

describe('the leg list', () => {
  it('is exactly the three intercompany legs, in chain order', () => {
    expect([...INVOICE_LEGS]).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
  })

  it('has a config and a label for every leg, and nothing else', () => {
    expect(Object.keys(LEG_CONFIG).sort()).toEqual([...INVOICE_LEGS].sort())
    const labels = INVOICE_LEGS.map((leg) => LEG_CONFIG[leg].label)
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toEqual(['SRO to Group', 'Group to USA', 'Group to Canada'])
    for (const leg of INVOICE_LEGS) expect(legLabel(leg)).toBe(LEG_CONFIG[leg].label)
  })

  it('pairs FX with every onward leg and none with the EUR leg', () => {
    for (const leg of INVOICE_LEGS) {
      const cfg = LEG_CONFIG[leg]
      expect(cfg.usesFx, leg).toBe(cfg.fxPair !== null)
      if (cfg.fxPair) expect(cfg.fxPair, leg).toBe(`EUR_${cfg.currency}`)
      else expect(cfg.currency, leg).toBe('EUR')
    }
  })

  it('sets up Group to Canada as Group selling to EB-CANADA in CAD at EUR_CAD', () => {
    expect(LEG_CONFIG.GROUP_TO_CANADA).toEqual({
      seller: 'EB-GROUP',
      buyer: 'EB-CANADA',
      currency: 'CAD',
      usesFx: true,
      fxPair: 'EUR_CAD',
      label: 'Group to Canada',
    })
  })

  it('keeps the two existing legs as they were', () => {
    expect(LEG_CONFIG.SRO_TO_GROUP).toMatchObject({ seller: 'EB-SRO', buyer: 'EB-GROUP', currency: 'EUR', usesFx: false })
    expect(LEG_CONFIG.GROUP_TO_USA).toMatchObject({ seller: 'EB-GROUP', buyer: 'EB-USA', currency: 'USD', usesFx: true, fxPair: 'EUR_USD' })
  })

  it('recognises legs and passes an unknown value through', () => {
    expect(isInvoiceLeg('GROUP_TO_CANADA')).toBe(true)
    expect(isInvoiceLeg('*')).toBe(false)
    expect(isInvoiceLeg(null)).toBe(false)
    expect(legLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE')
  })

  it('prints a symbol for each leg currency', () => {
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('CAD')).toBe('CA$')
    expect(currencySymbol('GBP')).toBe('GBP ')
  })
})

describe('legsForDestination', () => {
  it('always includes SRO to Group', () => {
    for (const codes of [[], ['US-BAL'], ['CA-HAM'], [null], ['EU-SK']]) {
      expect(legsForDestination(codes)[0], JSON.stringify(codes)).toBe('SRO_TO_GROUP')
    }
  })

  it('adds Group to USA for any US depot', () => {
    expect(legsForDestination(['US-BAL'])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA'])
    expect(legsForDestination(['US-SBD', 'US-SBD'])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA'])
  })

  it('adds Group to Canada for CA-HAM', () => {
    expect(legsForDestination(['CA-HAM'])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_CANADA'])
  })

  it('adds both onward legs for a container split between the US and Canada', () => {
    expect(legsForDestination(['CA-HAM', 'US-BAL'])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
  })

  it('adds both onward legs when the destination is unknown', () => {
    expect(legsForDestination([])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
    expect(legsForDestination([null])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
    expect(legsForDestination([undefined, ' '])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
    // One line with no depot could be bound for either.
    expect(legsForDestination(['US-BAL', null])).toEqual(['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'])
  })

  it('adds no onward leg for a known depot that is neither US nor CA-HAM', () => {
    expect(legsForDestination(['EU-SK'])).toEqual(['SRO_TO_GROUP'])
  })
})

describe('legs are enumerated in one module', () => {
  // An onward leg spelled out anywhere else is a second list that can fall out
  // of step. The one exception is the save action's zod shape, which is tied
  // back to the list with `satisfies Record<InvoiceLeg, ...>`, so a new leg
  // fails the typecheck there.
  const HOME = 'src/lib/invoice-legs.ts'
  const TIED = 'src/app/actions/invoices/save-hs-codes.ts'

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : []
    })
  }
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

  it('finds the tree', () => {
    expect(walk(join(process.cwd(), 'src')).length).toBeGreaterThan(100)
  })

  it('names GROUP_TO_USA and GROUP_TO_CANADA only in the legs module', () => {
    const offenders = walk(join(process.cwd(), 'src'))
      .map((full) => full.replace(`${process.cwd()}/`, ''))
      .filter((rel) => rel !== HOME && rel !== TIED)
      .filter((rel) => /GROUP_TO_(USA|CANADA)/.test(code(readFileSync(join(process.cwd(), rel), 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('ties the save action shape to the leg list', () => {
    expect(readFileSync(join(process.cwd(), TIED), 'utf8')).toMatch(/satisfies Record<InvoiceLeg, typeof code>/)
  })
})
