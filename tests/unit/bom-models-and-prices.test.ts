import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chosenModels, lineModels, productModelRows } from '@/lib/sku-model'
import { bamidaLabour } from '@/lib/bom-calc'
import { buildSupplierSpec, specFor } from '@/lib/supplier-spec'
import { stripBomMasterCosts } from '@/lib/price-visibility'
import { parseBamidaPriceDraft, parseBomView } from '@/lib/page-drafts'
import type { ModelSpec } from '@/lib/model-spec'
import type { BomMasterRow, SroPoBom, SroPoBomLine } from '@/lib/erp-types'

/**
 * Which model a product code is costed as, and Bamida's prices set in the Hub.
 *
 * Dean, 24 Sep 2026: "Okay can we fix naming gaps?" and "allow them to edit
 * these manully under BOM". product_code_master spells some products the way
 * the demand history does (H9X, dB-RT), which the manufacturing sheet's bill of
 * materials does not know, so those orders froze with no materials and no
 * Bamida prices. Every figure below is invented.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('lineModels: the product model, and the model it is costed as', () => {
  const catalogue = new Map<string, string | null>([['EBH9XNA', 'H9X 2.1W']])
  const master = new Map<string, string | null>([
    ['EBH9X', 'H9X'],
    ['DBRT', 'dB-RT'],
    ['EBH9', 'H9'],
    ['EBH10FR', null],
  ])
  const chosen = chosenModels([
    { sku: 'EBH9X', model_code: 'H9X 2.1W' },
    { sku: 'DBRT', model_code: 'NDT' },
    { sku: 'EBH10FR', model_code: 'H10' },
  ])

  it('costs a product as the model chosen under BOM and leaves its own model as it was', () => {
    expect(lineModels('EBH9X', catalogue, master, chosen)).toEqual({ model: 'H9X', bomModel: 'H9X 2.1W' })
    expect(lineModels('DBRT', catalogue, master, chosen)).toEqual({ model: 'dB-RT', bomModel: 'NDT' })
  })

  it('costs every other code as the product tables say', () => {
    expect(lineModels('EBH9', catalogue, master, chosen)).toEqual({ model: 'H9', bomModel: 'H9' })
    expect(lineModels('EBH9XNA', catalogue, master, chosen)).toEqual({ model: 'H9X 2.1W', bomModel: 'H9X 2.1W' })
  })

  it('gives a code the product tables cannot place the chosen model as its only one', () => {
    expect(lineModels('EBH10FR', catalogue, master, chosen)).toEqual({ model: 'H10', bomModel: 'H10' })
  })

  it('says null for both when nothing knows the code, and trims what it is given', () => {
    expect(lineModels('NOPE', catalogue, master, chosen)).toEqual({ model: null, bomModel: null })
    expect(lineModels('', catalogue, master, chosen)).toEqual({ model: null, bomModel: null })
    expect(lineModels(' EBH9X ', catalogue, master, chosen)).toEqual({ model: 'H9X', bomModel: 'H9X 2.1W' })
  })
})

describe('productModelRows: the Product codes tab', () => {
  const rows = productModelRows({
    catalogue: [
      { sku: 'EBH9XNA', product_name: 'H9X', bom_model_code: 'H9X 2.1W', region: 'NA', product_family: 'H9', active: true },
      { sku: 'HKNA', product_name: 'Hooks', bom_model_code: null, region: 'NA', product_family: 'ACC', active: true },
      { sku: 'OLDNA', product_name: 'Retired', bom_model_code: 'H9', region: 'NA', product_family: 'H9', active: false },
    ],
    master: [
      { internal_sku: 'EBH9', product_name: 'H9', bom_model_code: 'H9', product_family: 'H9', is_active: true },
      { internal_sku: 'EBH9X', product_name: 'H9X', bom_model_code: 'H9X', product_family: 'H9X', is_active: true },
      { internal_sku: 'EU3.5', product_name: 'EU 3.5', bom_model_code: 'EU3.5', product_family: 'EU3.5', is_active: true },
      { internal_sku: 'EBH10FR', product_name: 'H10 France', bom_model_code: null, product_family: 'H10', is_active: true },
      { internal_sku: 'BUN', product_name: 'Bungies', bom_model_code: null, product_family: 'Accessories', is_active: true },
      // A code both tables know appears once, as the catalogue has it.
      { internal_sku: 'EBH9XNA', product_name: 'H9X again', bom_model_code: 'WRONG', product_family: 'H9', is_active: true },
    ],
    chosen: [{ sku: 'EBH9X', model_code: 'H9X 2.1W', updated_by_label: 'someone@example.com', updated_at: '2026-01-02T03:04:05Z' }],
    bomModels: new Set(['H9', 'H9X 2.1W', 'NDT']),
  })
  const bySku = new Map(rows.map((r) => [r.sku, r]))

  it('puts the codes with no bill of materials first, so the ones to look at are on top', () => {
    expect(rows.map((r) => r.sku)).toEqual(['EBH10FR', 'EU3.5', 'EBH9', 'EBH9X', 'EBH9XNA'])
    expect(bySku.get('EU3.5')).toMatchObject({ model: 'EU3.5', hasBom: false })
    expect(bySku.get('EBH10FR')).toMatchObject({ model: null, hasBom: false })
  })

  it('shows what the list says, what was chosen, and who chose it', () => {
    expect(bySku.get('EBH9X')).toMatchObject({
      listModel: 'H9X',
      chosenModel: 'H9X 2.1W',
      model: 'H9X 2.1W',
      hasBom: true,
      chosenBy: 'someone@example.com',
      orderedBy: 'Group, UK and France',
    })
    expect(bySku.get('EBH9XNA')).toMatchObject({ listModel: 'H9X 2.1W', chosenModel: null, orderedBy: 'North America', name: 'H9X' })
  })

  it('leaves out accessories with no model and codes no longer in use, and keeps a barrier with no model', () => {
    expect(bySku.has('HKNA')).toBe(false)
    expect(bySku.has('BUN')).toBe(false)
    expect(bySku.has('OLDNA')).toBe(false)
    expect(bySku.has('EBH10FR')).toBe(true)
  })
})

describe('bamidaLabour: the Hub price over the sheet, part by part', () => {
  it('uses the sheet when nothing was set in the Hub', () => {
    expect(bamidaLabour('10.5000', '2.2500', null)).toEqual({ man: 10.5, print: 2.25, manFromHub: false, printFromHub: false })
    expect(bamidaLabour(null, undefined)).toEqual({ man: 0, print: 0, manFromHub: false, printFromHub: false })
  })

  it('lets a Hub price replace its own part and leaves the other to the sheet', () => {
    expect(bamidaLabour(10.5, 2.25, { manufacturing_eur: 11, printing_eur: null })).toEqual({
      man: 11,
      print: 2.25,
      manFromHub: true,
      printFromHub: false,
    })
    expect(bamidaLabour(10.5, 2.25, { manufacturing_eur: null, printing_eur: 0 })).toMatchObject({ man: 10.5, print: 0, printFromHub: true })
  })

  it('never lets a broken Hub value zero a price', () => {
    expect(bamidaLabour(10.5, 2.25, { manufacturing_eur: Number.NaN, printing_eur: null }).man).toBe(10.5)
  })
})

function spec(modelCode: string): ModelSpec {
  return { modelCode, productLabel: modelCode, graphicsNotes: [], specificRequirements: [] } as unknown as ModelSpec
}

function sroOrder(lines: Partial<SroPoBomLine>[]): SroPoBom {
  return {
    id: 'po-1',
    po_number: 'EBSRO00001-1',
    master_ref: null,
    from_entity: 'EB-SRO',
    to_entity: 'SUPPLIER',
    approved_at: null,
    created_at: '2026-01-01T00:00:00Z',
    bamida_total: 0,
    sro_total: 0,
    lines: lines.map((l) => ({
      sku: 'X',
      product_name: null,
      quantity: 10,
      model_code: null,
      has_bom: true,
      components: [],
      bamida_man_eur: 0,
      bamida_print_eur: 0,
      components_eur_unit: 0,
      bamida_total_line: 0,
      sro_total_line: 0,
      ...l,
    })) as SroPoBomLine[],
  }
}

describe('specFor: a specification under the model family Bamida templates use', () => {
  const specs = new Map([
    ['H9X', spec('H9X')],
    ['NDS', spec('NDS')],
    ['HT3.5', spec('HT3.5')],
  ])

  it('finds H9X for either roll width, which is how North America orders it', () => {
    for (const m of ['H9X 2.1W', 'H9X 1.5W']) {
      const out = buildSupplierSpec(sroOrder([{ model_code: m, bom_model_code: m }]), '2026-01-01', undefined, '', null, specs)
      expect(out.products[0].spec?.modelCode, m).toBe('H9X')
      expect(out.products[0].model, m).toBe(m)
    }
  })

  it('keeps finding H9X for a product now costed as a roll width, under its own name', () => {
    const out = buildSupplierSpec(sroOrder([{ model_code: 'H9X', bom_model_code: 'H9X 2.1W' }]), '2026-01-01', undefined, '', null, specs)
    expect(out.products[0].spec?.modelCode).toBe('H9X')
    expect(out.products[0].model).toBe('H9X')
  })

  it('finds the RS-200 template for a product costed as NDS200', () => {
    expect(specFor(specs, 'dB-RS', 'NDS200')?.modelCode).toBe('NDS')
    expect(specFor(specs, 'NoiseDefender', 'NDS200')?.modelCode).toBe('NDS')
  })

  it('looks under the costed model when the product model has none', () => {
    expect(specFor(specs, 'EU3.5', 'HT3.5')?.modelCode).toBe('HT3.5')
  })

  it('prefers the product model, and still says null when nothing has one', () => {
    const both = new Map([...specs, ['H9X 2.1W', spec('H9X 2.1W')]])
    expect(specFor(both, 'H9X', 'H9X 2.1W')?.modelCode).toBe('H9X')
    expect(specFor(specs, 'dB-RT', 'NDT')).toBeNull()
    expect(specFor(specs, null, null)).toBeNull()
    expect(specFor(specs, 'toString', 'constructor')).toBeNull()
  })

  it('leaves a frozen line with no costed model exactly as it was', () => {
    expect(specFor(specs, 'H9X', undefined)?.modelCode).toBe('H9X')
  })
})

describe('the sheet prices beside the Hub ones are money too', () => {
  it('strips them for a viewer without cost.view', () => {
    const rows = [
      {
        model_code: 'H9',
        product_line: null,
        week_start_date: '2026-01-05',
        bamida_man_eur: 11,
        bamida_print_eur: 2.25,
        bamida_total_eur: 13.25,
        sro_components_eur: 1,
        sro_duty_8pct_eur: 0,
        sro_admin_eur: 0,
        sro_total_eur: 1,
        bom_total_eur: 14.25,
        fx_gbp_eur: null,
        bom_change_pct: null,
        sheet_man_eur: 10.5,
        sheet_print_eur: 2.25,
        hub_price: { manufacturing: true, printing: false, by: 'someone@example.com', at: '2026-01-02T00:00:00Z' },
        component_detail: [],
      },
    ] as BomMasterRow[]
    const [s] = stripBomMasterCosts(rows, false)
    expect(s.sheet_man_eur).toBeNull()
    expect(s.sheet_print_eur).toBeNull()
    expect(s.hub_price).toBeNull()
    expect(s.bamida_man_eur).toBeNull()
  })
})

describe('page state for the two editors', () => {
  it('keeps a typed price and a "use the sheet" apart, and refuses anything else', () => {
    expect(parseBamidaPriceDraft({ v: 1, prices: { H9: { man: '11.2', print: null } } })).toEqual({
      v: 1,
      prices: { H9: { man: '11.2', print: null } },
    })
    expect(parseBamidaPriceDraft({ v: 1, prices: { H9: { man: 11 } } })).toBeNull()
    expect(parseBamidaPriceDraft({ v: 2, prices: {} })).toBeNull()
  })

  it('remembers the Product codes tab', () => {
    expect(parseBomView({ v: 1, tab: 'products', q: '' })?.tab).toBe('products')
    expect(parseBomView({ v: 1, tab: 'nope', q: '' })).toBeNull()
  })
})

describe('guard: who can change what, and what the public repository holds', () => {
  const actions = {
    productModel: code('src/app/actions/bom/product-model.ts'),
    prices: code('src/app/actions/bom/bamida-prices.ts'),
    recost: code('src/app/actions/bom/recost-sro-order.ts'),
  }

  it('gates every action before it reads or writes anything', () => {
    for (const [name, src] of Object.entries(actions)) {
      const gate = src.indexOf('auth.capabilities.has("bom.edit")')
      expect(gate, name).toBeGreaterThan(-1)
      for (const call of ['createAdminClient()', 'recostSroPo(', 'latestBomModels(', 'isKnownProductCode(']) {
        const at = src.indexOf(call, src.indexOf('export async function'))
        if (at > -1) expect(at, `${name}: ${call}`).toBeGreaterThan(gate)
      }
    }
  })

  it('asks for cost.view as well before a price can be set', () => {
    expect(actions.prices).toContain('auth.capabilities.has("cost.view")')
  })

  it('audits every change to bom_edit_log', () => {
    expect(actions.productModel).toMatch(/from\("bom_edit_log"\)\s*\.insert/)
    expect(actions.prices).toMatch(/from\("bom_edit_log"\)\.insert/)
    expect(actions.recost).toMatch(/from\("bom_edit_log"\)\s*\.insert/)
    expect(actions.productModel).toContain('`PRODUCT:${sku}`')
    expect(actions.recost).toContain('`ORDER:${result.poNumber}`')
  })

  it('re-costs only an approved order with no manufacturing order under it, and writes only while it is approved', () => {
    const bom = code('src/lib/bom.ts')
    const recost = bom.slice(bom.indexOf('export async function recostSroPo('))
    expect(recost).toContain("po.status !== 'approved'")
    expect(recost).toContain(".eq('leg', 'SRO_TO_SUPPLIER')")
    expect(recost).toContain("freezeSroPoCost(poId, 'approved')")
  })

  it('costs from the Hub tables, and fails loudly rather than costing without them', () => {
    const bom = code('src/lib/bom.ts')
    const ctx = bom.slice(bom.indexOf('async function buildExplodeCtx('), bom.indexOf('export async function loadSroPoBoms('))
    expect(ctx).toContain('loadHubBomChoices()')
    expect(ctx).toContain('lineModels(')
    const loader = bom.slice(bom.indexOf('async function loadHubBomChoices('), bom.indexOf('export async function latestBomModels('))
    expect(loader).toContain('throw new Error')
  })

  it('never seeds a price into the public repository, and leaves the demand feed column alone', () => {
    const migration = code('supabase/migrations/20260924180000_bom_product_models_and_bamida_prices.sql')
    expect(migration).not.toMatch(/insert\s+into\s+public\.bom_bamida_price/i)
    expect(migration).not.toMatch(/update\s+public\.product_code_master/i)
    expect(migration).toMatch(/revoke all on public\.%I from public, anon, authenticated/)
  })
})
