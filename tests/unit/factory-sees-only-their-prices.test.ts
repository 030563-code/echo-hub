import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBamidaPo } from '@/lib/bamida-po'
import { buildSupplierSpec } from '@/lib/supplier-spec'
import type { SroPoBom, SroPoBomLine } from '@/lib/erp-types'

/**
 * The manufacturer sees WHAT WE PAY THEM, and never what our materials cost us.
 *
 * Juraj, 18 Sep 2026, approving the priced order as a second factory download:
 * "Yes ... But hold on ... Only with their prices." Dean the same morning:
 * "Bamida must only see their prices not our material prices."
 *
 * That rule was already true when he said it, and this file is here so it stays
 * true. Both documents are built from SroPoBom, which carries BOTH sides of the
 * money: what Bamida charge us (bamida_man_eur, bamida_print_eur) and what the
 * goods cost us (components[].unit_cost_eur, components_eur_unit, sro_total_line,
 * and bamida_total_line, which is a total WITH our component cost inside it).
 * One line added to a document builder reaching for the wrong field would hand a
 * supplier our cost base, and the screen would look perfectly normal.
 *
 * So this is a behavioural test, not a source grep: our figures go in as
 * sentinel values that could not arise from any quantity, and the finished
 * documents are searched for them.
 */

/** Values that cannot be confused with a quantity, a pallet count or a rate. */
const OURS = {
  componentUnitCost: 9911.11,
  componentLineExtended: 9922.22,
  componentsEurUnit: 9933.33,
  /** (components + man + print) x qty, so our cost is inside it. */
  bamidaTotalLine: 9944.44,
  sroTotalLine: 9955.55,
  sroTotal: 9966.66,
}

/** What Bamida charge us. These SHOULD appear on the priced order. */
const THEIRS = { man: 46.3, print: 12.5 }

function bomWithOurCosts(): SroPoBom {
  const line: SroPoBomLine = {
    sku: 'EBH9NA',
    product_name: 'Echo Barrier H9',
    quantity: 70,
    model_code: 'H9',
    has_bom: true,
    components: [
      {
        code: 'PC350FR GR6',
        desc: 'Goretex',
        qty: 2,
        currency: 'EUR',
        dutiable: true,
        unit_cost_eur: OURS.componentUnitCost,
        extended_eur: OURS.componentUnitCost,
        line_qty: 140,
        line_extended_eur: OURS.componentLineExtended,
      },
    ],
    bamida_man_eur: THEIRS.man,
    bamida_print_eur: THEIRS.print,
    components_eur_unit: OURS.componentsEurUnit,
    bamida_total_line: OURS.bamidaTotalLine,
    sro_total_line: OURS.sroTotalLine,
  }
  return {
    id: 'po-1',
    po_number: 'EBGRP8001',
    master_ref: 'MR-1',
    from_entity: 'EB-GROUP',
    to_entity: 'EB-SRO',
    approved_at: null,
    created_at: '2026-09-16T00:00:00Z',
    lines: [line],
    bamida_total: OURS.bamidaTotalLine,
    sro_total: OURS.sroTotal,
  }
}

/** Every number we pay for the goods, as it would appear anywhere in a document. */
const ourFigures = Object.values(OURS)

function assertNoneOfOurCosts(document: unknown, what: string) {
  const text = JSON.stringify(document)
  for (const figure of ourFigures) {
    expect(text, `${what} leaks our cost ${figure}`).not.toContain(String(figure))
    // Rounded and truncated spellings of the same number, since a renderer may
    // format before printing.
    expect(text, `${what} leaks our cost ${figure} rounded`).not.toContain(figure.toFixed(0))
  }
}

describe('the priced order (-3) carries only what we pay Bamida', () => {
  const po = buildBamidaPo(bomWithOurCosts(), '2026-09-17', undefined, 'EBSRO8001-1')

  it('prints their manufacturing and printing rates', () => {
    const man = po.lines.find((l) => l.code === 'MANH9')
    const print = po.lines.find((l) => l.code === 'PRISTD')
    expect(man?.price).toBe(THEIRS.man)
    expect(print?.price).toBe(THEIRS.print)
    expect(po.priced).toBe(true)
  })

  it('never prints our component cost, our per-unit material cost, or any SRO total', () => {
    assertNoneOfOurCosts(po, 'the priced order')
    // The total is built from their rates and the two packaging prices only.
    expect(po.subtotal).toBe(70 * THEIRS.man + 70 * THEIRS.print + 19 + 85)
  })

  it('carries only the four kinds of line Bamida actually invoice us for', () => {
    // Manufacturing, printing, pallet covers, metal frames. Anything else on
    // this document is money that is not theirs to see.
    const allowed = /^(MAN[A-Z0-9.]+|PRISTD|Pallet COVERs|1781)$/
    for (const line of po.lines) {
      expect(line.code, `unexpected line on the priced order: ${line.code}`).toMatch(allowed)
    }
    expect(po.lines.map((l) => l.code)).toEqual(['MANH9', 'PRISTD', 'Pallet COVERs', '1781'])
  })

  it('does not even read the fields that hold our cost', () => {
    // Behaviour is pinned above; this catches the edit that would break it.
    const source = readFileSync(join(process.cwd(), 'src/lib/bamida-po.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const field of ['components', 'components_eur_unit', 'sro_total', 'bamida_total']) {
      expect(source, `buildBamidaPo reaches for ${field}`).not.toContain(field)
    }
  })
})

describe('the specification (-1) carries no money at all', () => {
  const spec = buildSupplierSpec(bomWithOurCosts(), '2026-09-17', undefined, 'EBSRO8001-1')

  it('leaks none of our costs', () => {
    assertNoneOfOurCosts(spec, 'the specification')
  })

  it('carries neither of their rates either: it is the sheet the floor builds from', () => {
    const text = JSON.stringify(spec)
    expect(text).not.toContain(String(THEIRS.man))
    expect(text).not.toContain(String(THEIRS.print))
  })

  it('its material figures are quantities, and the renderer prints no currency', () => {
    // perUnit 2 m² per barrier over 70 barriers is 140: a quantity, not money.
    const material = spec.products[0].materials[0]
    expect(material.perUnit).toBe(2)
    expect(material.total).toBe(140)
    const pdf = readFileSync(join(process.cwd(), 'src/lib/supplier-spec-pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const money of ['EUR', '€', 'price', 'amount', 'subtotal']) {
      expect(pdf, `the specification renderer prints ${money}`).not.toContain(money)
    }
  })
})

describe('nothing else the factory can see carries a figure in money', () => {
  it('the shortage block and the capability table are quantities only', () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
    // need/have/short on the order page, and needed/short on the stock page,
    // are material quantities. A price field on either would be our cost.
    const orders = read('src/lib/factory/orders.ts')
    expect(orders).toContain('export interface FactoryShortMaterial')
    for (const money of ['price', 'cost', 'eur', 'EUR']) {
      expect(orders.slice(orders.indexOf('FactoryShortMaterial')).slice(0, 400)).not.toContain(money)
    }
    const math = read('src/lib/factory/capability-math.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const money of ['price', 'unit_price', 'cost', 'eur']) {
      expect(math, `the capability maths reaches for ${money}`).not.toContain(money)
    }
  })
})
