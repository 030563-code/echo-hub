import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelForSku, modelMaps } from '@/lib/sku-model'

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
