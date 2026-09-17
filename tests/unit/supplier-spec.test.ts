import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { sroDocumentNumber } from '@/lib/po-number'
import { buildSupplierSpec, specificationRows, STANDARD_PRINTING } from '@/lib/supplier-spec'
import type { ModelSpec } from '@/lib/model-spec'
import type { SroPoBom, SroPoBomLine } from '@/lib/erp-types'

function line(over: Partial<SroPoBomLine> & { model_code: string }): SroPoBomLine {
  return {
    sku: 'EBH9NA',
    product_name: 'Echo Barrier H9',
    quantity: 140,
    has_bom: true,
    components: [
      { code: 'SK-PVC', desc: 'PVC Mehler', qty: 2, line_qty: 280, line_extended_eur: 0 },
      // Inbound transport recharge: a cost line, not something to put in a barrier.
      { code: 'SK-TRNS', desc: 'Inbound transport', qty: 1, line_qty: 140, line_extended_eur: 0 },
    ] as SroPoBomLine['components'],
    bamida_man_eur: 0,
    bamida_print_eur: 0,
    components_eur_unit: 0,
    bamida_total_line: 0,
    sro_total_line: 0,
    ...over,
  }
}

function bom(lines: SroPoBomLine[]): SroPoBom {
  return {
    id: 'po-1',
    po_number: 'EBSRO8001-1',
    master_ref: 'MR-1',
    from_entity: 'EB-SRO',
    to_entity: 'SUPPLIER',
    approved_at: null,
    created_at: '2026-09-17T00:00:00Z',
    lines,
    bamida_total: 0,
    sro_total: 0,
  } as SroPoBom
}

function spec(over: Partial<ModelSpec> & { modelCode: string }): ModelSpec {
  return {
    productLabel: 'Echo Barrier H9',
    dimensions: '1335 x 2050 mm',
    graphicsPrint: 'w3+cmyk2',
    graphicsNotes: ['Grafika ENG'],
    graphicsWithLogo: null,
    pvcType: 'PVC Mehler 900gr/ B1/matný lak L&B 8540-636',
    pvcRal: '6026',
    pvcColour: 'Zelená/Green',
    meshType: null,
    meshColour: null,
    goretexType: 'PC350FR Grade 6 /2,1m',
    goretexColour: 'Čierna/Black',
    infillType: 'SENIZOL EB3 (1050g)',
    infillDimensions: '1580 x 960 x TL 40 mm',
    threadType: 'NC Tech',
    threadColour: 'Oranžová/Orange',
    reflectiveType: 'áno/zvaranie',
    reflectiveColour: 'Strieborná/Silver',
    rings: 'D 25 mm / mosadzné',
    buckles: 'BEZ praciek',
    palletType: '210x140cm FYTO',
    construction: 'Ano',
    maxPalletHeight: 'MAX výška palety 235 cm !!!',
    specificRequirements: ['scanovanie datatagov'],
    packConfig: '9x70 ks',
    includeWithOrder: null,
    sourceDocument: 'PO-00001413',
    confirmed: false,
    notes: null,
    ...over,
  }
}

describe('buildSupplierSpec attaches the manufacturing specification', () => {
  it('matches a specification to its product by model code', () => {
    const specs = new Map([['H9', spec({ modelCode: 'H9' })]])
    const out = buildSupplierSpec(bom([line({ model_code: 'H9' })]), '2026-09-17', undefined, 'X', null, specs)

    expect(out.products).toHaveLength(1)
    expect(out.products[0].spec?.modelCode).toBe('H9')
    expect(out.products[0].spec?.pvcRal).toBe('6026')
    expect(out.products[0].spec?.packConfig).toBe('9x70 ks')
  })

  it('carries null rather than a neighbour when the model has no specification', () => {
    const specs = new Map([['H9', spec({ modelCode: 'H9' })]])
    const out = buildSupplierSpec(bom([line({ model_code: 'H10' })]), '2026-09-17', undefined, 'X', null, specs)

    expect(out.products[0].model).toBe('H10')
    expect(out.products[0].spec).toBeNull()
  })

  it('keeps every existing caller working: no map means no specification, not a crash', () => {
    const out = buildSupplierSpec(bom([line({ model_code: 'H9' })]), '2026-09-17')
    expect(out.products[0].spec).toBeNull()
    expect(out.printing).toBe(STANDARD_PRINTING)
  })

  it('still excludes recharge lines from the materials, which are a cost not an ingredient', () => {
    const out = buildSupplierSpec(bom([line({ model_code: 'H9' })]), '2026-09-17')
    expect(out.products[0].materials.map((m) => m.code)).toEqual(['SK-PVC'])
  })

  it('resolves each product independently when an order carries several', () => {
    const specs = new Map([
      ['H9', spec({ modelCode: 'H9', packConfig: '9x70 ks' })],
      ['H10Japan', spec({ modelCode: 'H10Japan', packConfig: '8x65', includeWithOrder: 'Háky Japonský typ: 700 ks' })],
    ])
    const out = buildSupplierSpec(
      bom([line({ model_code: 'H9' }), line({ model_code: 'H10Japan', sku: 'EBH10JAPSK' })]),
      '2026-09-17', undefined, 'X', null, specs,
    )
    expect(out.products.map((p) => p.spec?.packConfig)).toEqual(['9x70 ks', '8x65'])
    expect(out.products[1].spec?.includeWithOrder).toContain('Háky')
  })
})


/** Source with comments removed, so a guard cannot pass or fail on its own prose. */
const codeOnly = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('guard: the specification document tells the truth about itself', () => {
  const pdf = codeOnly(readFileSync(join(process.cwd(), 'src/lib/supplier-spec-pdf.ts'), 'utf8'))
  const lib = readFileSync(join(process.cwd(), 'src/lib/supplier-spec.ts'), 'utf8')

  it('names nobody at Echo Barrier and cites no internal document', () => {
    // 🔴 Dean, 17 Sep 2026, on "Specification confirmed by Operations on
    // 2026-09-17. Read from template": "Please remove these on the client facing
    // Document not needed at all."
    //
    // The gate is what made it redundant. That line warned the factory off a
    // sheet nobody had checked, back when an unconfirmed specification could be
    // sent. sendManufacturingPoToBamida now refuses one, so they can only ever
    // receive a signed document and the warning warns of nothing.
    expect(pdf).not.toContain('SPECIFICATION NOT YET CONFIRMED')
    expect(pdf).not.toContain('Specification confirmed by')
    expect(pdf).not.toContain('Check before building')
    expect(pdf).not.toContain('sourceDocument')
  })

  it('keeps the send gated, which is what replaced the warning', () => {
    const send = readFileSync(
      join(process.cwd(), 'src/app/actions/purchase-orders/send-manufacturing-po.ts'),
      'utf8',
    )
    expect(send).toContain('if (!spec.confirmedAt)')
  })

  it('says when it holds no specification at all rather than printing nothing', () => {
    expect(pdf).toContain('No manufacturing specification held for')
  })

  it('decides what to say from what it PRINTED, not from a database field', () => {
    // An edited document has no ModelSpec behind it and is still a specification;
    // keying off `spec === null` would have called every hand-written one empty.
    expect(pdf).toContain('product.specRows.length === 0 && product.bullets.length === 0')
    expect(pdf).not.toContain('product.spec === null')
  })

  it('does not print the "Standard" placeholder alongside a real graphics spec', () => {
    expect(pdf).toContain('spec.products.every((p) => p.specRows.length === 0)')
  })

  it('renders the fields Juraj asked for', () => {
    for (const label of ['PVC', 'Mesh (sieťka)', 'Goretex', 'Infill (materiál výplne)',
      'Thread (nite)', 'Reflective strips', 'Rings (krúžky)', 'Buckles (pracky)',
      'Pallet type', 'Pallet height', 'Pack (balenie)', 'Include (pribaliť)']) {
      expect(lib).toContain(label)
    }
    expect(pdf).toContain('Specific requirements')
  })

  it('only imports the specification type, never the server-only module, into the pure builder', () => {
    // model-spec.ts carries `import 'server-only'`; a value import would break
    // every unit test that exercises this module.
    expect(lib).toContain("import type { ModelSpec } from '@/lib/model-spec'")
    expect(lib).not.toMatch(/^import \{[^}]*\} from '@\/lib\/model-spec'/m)
  })

  it('draws nothing without a width, which is what ran off the page', () => {
    // 🔴 Every bare doc.text(x, y) with no maxWidth is an overflow waiting for a
    // longer value. The only unbounded calls left are the centred headings and
    // the footer, which are fixed-length by construction.
    expect(pdf).toContain('doc.splitTextToSize')
    expect(pdf).toContain('maxWidth: CONTENT_W')
    // Column widths are stated so a cell wraps at a width this file chose.
    expect(pdf).toContain('cellWidth: SPEC_LABEL_W')
    expect(pdf).toContain("overflow: 'linebreak'")
  })

  it('uses a font that can spell Slovak', () => {
    // 🔴 Core Helvetica is CP1252 and printed "pod>a" for "podľa" and dropped the
    // C of "Čierna" on the sheet the factory builds from.
    expect(pdf).toContain("import { registerUnicodeFont } from '@/lib/pdf-font'")
    expect(pdf).not.toContain("'helvetica'")
    for (const file of ['src/lib/bamida-po-pdf.ts', 'src/lib/transport-order-pdf.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('registerUnicodeFont(doc)')
      expect(source, file).not.toContain("'helvetica'")
    }
  })
})

describe('guard: the shipping order is a document, never a second purchase order', () => {
  // 🔴 Two things used to be able to carry the number EBSRO<n>-2: this document,
  // derived from the group order's number, and a real SRO_TO_CARGO purchase
  // order row whose number hub_mint_po_number derives the same way. Dean,
  // 17 Sep 2026: "Shipping document raised from -1 is the real one. Raise Cargo
  // PO should probably be removed."
  const files = [
    'src/app/actions/purchase-orders/raise-cargo-po.ts',
    'src/components/po/cargo-po-button.tsx',
  ]

  it('has no way to raise a cargo purchase order', () => {
    for (const file of files) {
      expect(existsSync(join(process.cwd(), file)), `${file} is back`).toBe(false)
    }
  })

  it('has no caller left behind either', () => {
    for (const dir of ['src/app', 'src/components', 'src/lib']) {
      const hits = execSync(
        `grep -rl "raiseCargoPo\\|CargoPoButton" ${dir} || true`,
        { cwd: process.cwd(), encoding: 'utf8' },
      ).trim()
      expect(hits, `${dir} still references the removed cargo PO`).toBe('')
    }
  })

  it('still derives the shipping document number from the group order', () => {
    // The document keeps the -2 suffix. That is the whole point: there is now
    // exactly one thing wearing it.
    expect(sroDocumentNumber('EBGRP8001', 'Shipping')).toBe('EBSRO8001-2')
    expect(sroDocumentNumber('EBGRP8001', 'Manufacturing')).toBe('EBSRO8001-1')
    expect(sroDocumentNumber('EBGRP8001', 'Accounting')).toBe('EBSRO8001-3')
  })
})

describe('guard: our own working notes never reach the factory', () => {
  /**
   * 🔴 Dean, 17 Sep 2026: "why tf would include this / Note Read from a single UK order dated
   * 06.08.2026 because H9 has no template. Confirm with Juraj that these are the standing H9
   * values rather than that order's. / In a CLIENT FACING FUCKEN PO and we fucken resolved it"
   *
   * model_spec.notes is our note to OURSELVES about how sure we are of a row. It was printed as a
   * "Note" line on the build sheet that goes to the supplier. Behavioural, not a grep: every field
   * gets a unique marker and the output is searched for the one that must never appear.
   */
  const marker = (k: string) => `MARKER_${k}`
  const everyFieldMarked: ModelSpec = {
    modelCode: 'H9', productLabel: marker('productLabel'), dimensions: marker('dimensions'),
    graphicsPrint: marker('graphicsPrint'), graphicsNotes: [marker('graphicsNotes')],
    graphicsWithLogo: marker('graphicsWithLogo'),
    pvcType: marker('pvcType'), pvcRal: marker('pvcRal'), pvcColour: marker('pvcColour'),
    meshType: marker('meshType'), meshColour: marker('meshColour'),
    goretexType: marker('goretexType'), goretexColour: marker('goretexColour'),
    infillType: marker('infillType'), infillDimensions: marker('infillDimensions'),
    threadType: marker('threadType'), threadColour: marker('threadColour'),
    reflectiveType: marker('reflectiveType'), reflectiveColour: marker('reflectiveColour'),
    rings: marker('rings'), buckles: marker('buckles'),
    palletType: marker('palletType'), construction: marker('construction'),
    maxPalletHeight: marker('maxPalletHeight'),
    specificRequirements: [marker('specificRequirements')],
    packConfig: marker('packConfig'), includeWithOrder: marker('includeWithOrder'),
    sourceDocument: marker('sourceDocument'), confirmed: false, notes: marker('notes'),
  }

  const printed = JSON.stringify(specificationRows(everyFieldMarked))

  it('does not print notes on the specification', () => {
    expect(printed).not.toContain(marker('notes'))
  })

  it('does not print the source document as a row either', () => {
    // It belongs in the one provenance line at the foot, not as a build instruction.
    expect(printed).not.toContain(marker('sourceDocument'))
  })

  it('still prints every field that IS an instruction to the factory', () => {
    for (const field of ['dimensions', 'pvcType', 'pvcColour', 'pvcRal', 'meshType', 'goretexType',
      'infillType', 'infillDimensions', 'threadType', 'reflectiveType', 'rings', 'buckles',
      'graphicsPrint', 'graphicsWithLogo', 'palletType', 'construction', 'maxPalletHeight',
      'packConfig', 'includeWithOrder']) {
      expect(printed, `${field} stopped printing`).toContain(marker(field))
    }
  })

  it('names the field as internal where it is declared, so the next person does not re-add it', () => {
    const model = readFileSync(join(process.cwd(), 'src/lib/model-spec.ts'), 'utf8')
    expect(model).toContain('INTERNAL ONLY')
    expect(model).toContain('NEVER PRINTED')
  })
})
