import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSupplierSpec, STANDARD_PRINTING } from '@/lib/supplier-spec'
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

describe('guard: the specification document tells the truth about itself', () => {
  const pdf = readFileSync(join(process.cwd(), 'src/lib/supplier-spec-pdf.ts'), 'utf8')
  const lib = readFileSync(join(process.cwd(), 'src/lib/supplier-spec.ts'), 'utf8')

  it('says on its face when a specification has not been confirmed', () => {
    // 🔴 An unconfirmed spec was read off one historic order. The factory must be
    // told that, on the document, not only in the database.
    expect(pdf).toContain('SPECIFICATION NOT YET CONFIRMED')
    expect(pdf).toContain('Check before building')
  })

  it('prints who signed it once somebody has', () => {
    // Dean, 17 Sep 2026: "That way nothing goes unsigned." A name and a date, or
    // the warning. Never neither.
    expect(pdf).toContain('Specification confirmed by ${spec.approval.by}')
  })

  it('says when it holds no specification at all rather than printing nothing', () => {
    expect(pdf).toContain('No manufacturing specification held for')
  })

  it('decides what to say from what it PRINTED, not from a database field', () => {
    // An edited document has no ModelSpec behind it and is still a specification;
    // keying off `spec === null` would have called every hand-written one empty.
    expect(pdf).toContain('product.specRows.length > 0 || product.bullets.length > 0')
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
