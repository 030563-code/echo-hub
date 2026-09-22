import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { internalSkuFor, internalSkuMaps, modelForSku, modelMaps } from '@/lib/sku-model'

/**
 * A line's SKU to its manufacturing model, through both tables that know it.
 * France, the UK and Group order under the internal SKUs since 22 Sep 2026,
 * which only product_code_master maps; the North American and Japan SKUs are
 * in po_product_catalog.
 */
const maps = modelMaps(
  [
    { sku: 'EBH9NA', bom_model_code: 'H9' },
    { sku: 'EBH9JAPSK', bom_model_code: 'H9Japan' },
    { sku: 'BUNNA', bom_model_code: null },
  ],
  [
    { internal_sku: 'EBH9', bom_model_code: 'H9' },
    { internal_sku: 'COMP', bom_model_code: 'CSCompact' },
    { internal_sku: 'BUN', bom_model_code: null },
    // Where both know a key, the catalogue answers first.
    { internal_sku: 'EBH9NA', bom_model_code: 'WRONG' },
  ],
)

describe('modelForSku', () => {
  it('answers a North American SKU from the catalogue', () => {
    expect(modelForSku('EBH9NA', maps.catalogue, maps.master)).toBe('H9')
    expect(modelForSku('EBH9JAPSK', maps.catalogue, maps.master)).toBe('H9Japan')
  })

  it('answers an internal SKU from the code master, which is what France and the UK order under', () => {
    expect(modelForSku('EBH9', maps.catalogue, maps.master)).toBe('H9')
    expect(modelForSku('COMP', maps.catalogue, maps.master)).toBe('CSCompact')
  })

  it('says null for a SKU neither table can place, rather than guessing', () => {
    expect(modelForSku('EBH9SK', maps.catalogue, maps.master)).toBeNull()
    expect(modelForSku('BUNNA', maps.catalogue, maps.master)).toBeNull()
    expect(modelForSku('', maps.catalogue, maps.master)).toBeNull()
  })

  it('lets the catalogue win where both tables know the key, and trims what it is given', () => {
    expect(modelForSku(' EBH9NA ', maps.catalogue, maps.master)).toBe('H9')
  })

  it('is used by the bill of materials and the packing list', () => {
    for (const file of ['src/lib/bom.ts', 'src/lib/despatch/packing-list-store.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      expect(src, file).toContain("from('product_code_master').select('internal_sku, bom_model_code')")
      expect(src, file).toContain('modelForSku(')
    }
  })
})

/**
 * The internal SKU: what a French EBH9X and a Baltimore EBH9XNA have in common,
 * and the key the bills of materials are reached through since 22 Sep 2026.
 */
const identity = internalSkuMaps(
  [
    { sku: 'EBH9NA', internal_sku: 'EBH9' },
    { sku: 'EBH9ERNA', internal_sku: 'EBH9' },
    { sku: 'EBH9XNA', internal_sku: 'EBH9X' },
    { sku: 'V2NA', internal_sku: 'V2' },
    { sku: 'NOINTERNAL', internal_sku: null },
  ],
  [{ internal_sku: 'EBH9' }, { internal_sku: 'EBH9X' }, { internal_sku: 'V2' }, { internal_sku: 'NDS' }],
)

describe('internalSkuFor', () => {
  it('resolves a regional SKU through the catalogue', () => {
    expect(internalSkuFor('EBH9XNA', identity)).toBe('EBH9X')
    expect(internalSkuFor('EBH9NA', identity)).toBe('EBH9')
    // The ex-rental H9 is an H9 and draws on the H9 recipe.
    expect(internalSkuFor('EBH9ERNA', identity)).toBe('EBH9')
  })

  it('answers an internal SKU with itself, which is what France and the UK order under', () => {
    expect(internalSkuFor('EBH9X', identity)).toBe('EBH9X')
    expect(internalSkuFor('NDS', identity)).toBe('NDS')
  })

  it('puts a French order and a Baltimore order on the same product', () => {
    expect(internalSkuFor('EBH9X', identity)).toBe(internalSkuFor('EBH9XNA', identity))
  })

  it('says null for an s.r.o. SKU or anything neither table places, rather than guessing', () => {
    expect(internalSkuFor('EBH9SK', identity)).toBeNull()
    expect(internalSkuFor('NOINTERNAL', identity)).toBeNull()
    expect(internalSkuFor('', identity)).toBeNull()
  })

  it('trims what it is given', () => {
    expect(internalSkuFor(' EBH9XNA ', identity)).toBe('EBH9X')
  })
})

describe('the capability check reaches the bill of materials through the internal SKU', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/manufacturing-capability.ts'), 'utf8')
  const code = src
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .join('\n')

  it('has no allowlist: the data decides what is computable', () => {
    // 🔴 Until 22 Sep 2026 one line read MANUFACTURABLE_SKUS = new Set(['EBH9NA']),
    // so eighteen products with a bill of materials read "not confirmed yet".
    expect(code).not.toContain('MANUFACTURABLE_SKUS')
    expect(code).not.toContain("new Set(['EBH9NA'])")
  })

  it('normalises both sides of every join to the internal SKU', () => {
    expect(code).toContain('internalSkuMaps(')
    expect(code).toContain('fgByInternal')
    expect(code).toContain('internalSkuFor(String(r.hub_sku), identity)')
    // The whole map, because its keys are regional and the order's may not be.
    expect(code).not.toContain(".in('hub_sku', skus)")
    expect(code).not.toContain(".in('finished_sku', skus)")
  })

  it('prints no provisional caption anywhere, on any screen', () => {
    // Dean, 22 Sep 2026: "do not worry about labels please they know this
    // Bamida provided this to us." They sent us the delivery notes.
    for (const file of [
      'src/lib/factory/strings.ts',
      'src/app/(dashboard)/factory/stock/factory-capability-table.tsx',
      'src/app/(dashboard)/factory/stock/[fg]/page.tsx',
      'src/app/(dashboard)/purchase-orders/[id]/fulfilment-card.tsx',
    ]) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), file).not.toContain('capProvisional')
    }
    expect(code).not.toContain('mappingProvisional')
  })
})
