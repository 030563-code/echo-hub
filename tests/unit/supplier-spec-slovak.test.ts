import { describe, it, expect, vi, beforeAll } from 'vitest'
import { buildSupplierSpecPdf } from '@/lib/supplier-spec-pdf'
import { specificationRows, specRowLabelSk, type SupplierSpec, type SupplierSpecProduct } from '@/lib/supplier-spec'
import type { ModelSpec } from '@/lib/model-spec'

/**
 * The -1 OBJEDNÁVKOVÝ LIST speaks Slovak, all of it.
 *
 * The factory builds from this sheet. Its masthead was Slovak but every heading and label under
 * it was English, over Slovak values, and the factory found it unclear. This renders the real
 * renderer and reads back what it drew, so a heading left in English fails here rather than on
 * the factory floor. Every name, address and number below is invented.
 */

const drawn = vi.hoisted(() => [] as string[])
vi.mock('jspdf', async (original) =>
  (await import('./pdf-text')).recordingJsPdf(await original<typeof import('jspdf')>(), drawn))

const product = (over: Partial<SupplierSpecProduct>): SupplierSpecProduct => ({
  model: 'H9',
  name: 'Test barrier A',
  quantity: 140,
  packSize: 70,
  pallets: 2,
  materials: [],
  spec: null,
  specRows: [],
  bullets: [],
  sourceDocument: null,
  ...over,
})

const SPEC: SupplierSpec = {
  specNumber: 'TEST-MFG-1',
  date: '2026-03-10',
  supplier: { name: 'Testovacia Výroba s.r.o.', address: ['Skúšobná 1', '000 01 Testovo'] },
  buyer: { name: 'Testovací Odberateľ s.r.o.', address: ['Vzorová 2', '000 02 Príkladovo'], taxNumber: 'SK0000000001' },
  destination: 'Test depot',
  products: [
    product({
      materials: [
        { code: 'TST-1', description: 'Skúšobná tkanina', perUnit: 1.5, total: 210, colour: 'Čierna' },
        { code: 'TST-2', description: 'Skúšobná výplň', perUnit: 1, total: 140 },
      ],
      // The labels the Hub writes, exactly as a saved document stores them, and one typed by hand.
      specRows: [
        { label: 'Rings (krúžky)', value: 'Skúšobné krúžky 25 mm' },
        { label: 'Pallet type', value: 'Skúšobná paleta' },
        { label: 'Poznámka pre sklad', value: 'Skúšobná poznámka' },
      ],
      bullets: ['Skúšobná požiadavka'],
    }),
    product({ model: 'H10', name: 'Test barrier B', quantity: 70, pallets: 1 }),
    product({ model: 'H8', name: 'Test barrier C', quantity: 150, packSize: 30, pallets: 5 }),
  ],
  packing: { pallets: 8, palletCovers: 8, metalFrames: 6 },
  printing: 'Standard',
}

let text: string[] = []
beforeAll(async () => {
  drawn.length = 0
  await buildSupplierSpecPdf(SPEC)
  text = [...drawn]
})

describe('the -1 prints every heading and label in Slovak', () => {
  it('heads the sheet, the parties, the date and the destination in Slovak', () => {
    for (const heading of [
      'OBJEDNÁVKOVÝ LIST',
      'VÝROBNÁ ŠPECIFIKÁCIA TEST-MFG-1',
      'Dodávateľ',
      'Odberateľ',
      'IČ DPH: SK0000000001',
      'Dátum: 2026-03-10',
      'Miesto určenia: Test depot',
    ]) {
      expect(text, heading).toContain(heading)
    }
  })

  it('labels the summary, the packing and the detail in Slovak, with Slovak units', () => {
    for (const label of [
      'Model', 'Produkt', 'Množstvo', '140 ks', 'Spolu', '360 ks',
      'Balenie', 'Palety', 'Kryty na palety', 'Kovové rámy na palety',
      'Podrobná špecifikácia', 'Test barrier A  140 ks',
      'Kód', 'Materiál', 'Farba', 'Na kus',
      'Špecifikácia: H9', 'Špecifické požiadavky',
    ]) {
      expect(text, label).toContain(label)
    }
    // The page count is the layout's business; the words around it are this test's.
    expect(text.some((s) => /^Strana 1 z \d+$/.test(s))).toBe(true)
  })

  it('counts pallets the Slovak way: 1 paleta, 2 to 4 palety, 5 paliet', () => {
    expect(text).toContain('Model H9 · 70 ks na paletu · 2 palety')
    expect(text).toContain('Model H10 · 70 ks na paletu · 1 paleta')
    expect(text).toContain('Model H8 · 30 ks na paletu · 5 paliet')
  })

  it('prints the Hub row labels in Slovak and a hand-typed label exactly as typed', () => {
    expect(text).toContain('Krúžky')
    expect(text).toContain('Typ palety')
    expect(text).toContain('Poznámka pre sklad')
    // The values are content and print untouched.
    expect(text).toContain('Skúšobné krúžky 25 mm')
  })

  it('leaves no English heading, label or unit behind', () => {
    const english = [
      'MANUFACTURING SPECIFICATION', 'Supplier', 'Buyer', 'Tax:', 'Date:', 'Destination:',
      'Product', 'Quantity', 'Total', 'Packing', 'Pallets', 'Pallet covers', 'Metal frames',
      'Printing', 'Detailed specification', 'Code', 'Material', 'Colour', 'Per barrier',
      'Specification', 'Specific requirements', 'Page ', 'pcs', 'units', 'per pallet',
      'Rings', 'Pallet type',
    ]
    for (const word of english) {
      expect(text.filter((s) => s.includes(word)), word).toEqual([])
    }
  })
})

describe('every row label the Hub can write has its Slovak form', () => {
  it('translates all sixteen, in the order the sheet prints them', () => {
    // Every field set, so every row the builder knows about is emitted.
    const everything: ModelSpec = {
      modelCode: 'H9', productLabel: 'Test', dimensions: 'x',
      graphicsPrint: 'x', graphicsNotes: [], graphicsWithLogo: 'x',
      pvcType: 'x', pvcRal: '0000', pvcColour: 'x', meshType: 'x', meshColour: 'x',
      goretexType: 'x', goretexColour: 'x', infillType: 'x', infillDimensions: 'x',
      threadType: 'x', threadColour: 'x', reflectiveType: 'x', reflectiveColour: 'x',
      rings: 'x', buckles: 'x', palletType: 'x', construction: 'x', maxPalletHeight: 'x',
      specificRequirements: [], packConfig: 'x', includeWithOrder: 'x',
      sourceDocument: 'test', confirmed: false,
      // Our internal note is never a row, so it has no Slovak form to need.
      notes: 'x',
    }
    expect(specificationRows(everything).map((r) => specRowLabelSk(r.label))).toEqual([
      'Rozmery', 'PVC', 'Sieťka', 'Goretex', 'Materiál výplne', 'Nite', 'Reflexné pásy', 'Krúžky',
      'Pracky', 'Grafika', 'Grafika s logom', 'Typ palety', 'Konštrukcia', 'Výška palety',
      'Balenie', 'Pribaliť',
    ])
  })

  it('never turns a hand-typed label into something else', () => {
    expect(specRowLabelSk('Poznámka pre sklad')).toBe('Poznámka pre sklad')
    expect(specRowLabelSk('constructor')).toBe('constructor')
  })
})
