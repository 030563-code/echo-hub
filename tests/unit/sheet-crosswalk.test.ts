import { describe, it, expect } from 'vitest'
import { resolveSheetSku, mappedSkus } from '@/lib/pricing/sheet-crosswalk'

/**
 * This module decides which product a sheet price attaches to. A wrong entry
 * does not throw, it charges a customer the price of a different product, so
 * every rule is pinned rather than sampled.
 */

describe('resolveSheetSku, Echo Barrier own part numbers', () => {
  it.each([
    ['H8-0001', 'EBH8NA'],
    ['H9-0001', 'EBH9NA'],
    ['H9X-0001', 'EBH9XNA'],
    ['H10-0001', 'EBH10NA'],
    ['CSC-0001', 'CCSNA'],
    ['CS-0001', 'FSCNA'],
    ['M1-0001', 'M1NA'],
    ['VK-0001', 'EBVFKNA'],
    ['HK-0001', 'HKNA'],
    ['BG-0001', 'BUNNA'],
  ])('%s resolves to %s', (part, sku) => {
    expect(resolveSheetSku(part)).toEqual({ ok: true, sku })
  })

  // The part number says V1FF; the description on the same row says "V2
  // Accoustical Barrier". V1 has no US or Canada item code anywhere, so the
  // description is the truthful half.
  it('reads V1FF-0001 as the V2, following the description not the code', () => {
    expect(resolveSheetSku('V1FF-0001')).toEqual({ ok: true, sku: 'V2NA' })
  })
})

describe('resolveSheetSku, contractor part numbers', () => {
  it('maps Herc short codes', () => {
    expect(resolveSheetSku('H9G')).toEqual({ ok: true, sku: 'EBH9NA' })
    expect(resolveSheetSku('H10G')).toEqual({ ok: true, sku: 'EBH10NA' })
    expect(resolveSheetSku('H9XG')).toEqual({ ok: true, sku: 'EBH9XNA' })
    expect(resolveSheetSku('CCS')).toEqual({ ok: true, sku: 'CCSNA' })
    expect(resolveSheetSku('FSCS')).toEqual({ ok: true, sku: 'FSCNA' })
  })

  // EBH10HERCNA is not a HubSpot product; EBH10HERC is. Pricing the other one
  // would leave Herc's own H10 with no price at all.
  it('maps the Herc-logo H10 to EBH10HERC, never EBH10HERCNA', () => {
    expect(resolveSheetSku('H10B')).toEqual({ ok: true, sku: 'EBH10HERC' })
    expect(mappedSkus()).not.toContain('EBH10HERCNA')
  })

  it('maps the spelled-out names United Rentals, HERMEQ and SunBelt use', () => {
    expect(resolveSheetSku('ECHOBARRIER H9 GREEN')).toEqual({ ok: true, sku: 'EBH9NA' })
    expect(resolveSheetSku('ECHOBARRIER H10 GREEN')).toEqual({ ok: true, sku: 'EBH10NA' })
    expect(resolveSheetSku('ECHOBARRIER CSC ENCLOSURE')).toEqual({ ok: true, sku: 'CCSNA' })
    expect(resolveSheetSku('ECHOBARRIER CS ENCLOSURE')).toEqual({ ok: true, sku: 'FSCNA' })
  })

  // United Rentals' 2026 column renamed the V2 to "V1 FRAME" while its 2025
  // column and the description both say V2. Same row, same product.
  it('treats United Rentals V1 FRAME and V2 FRAME as the same product', () => {
    expect(resolveSheetSku('ECHOBARRIER V1 FRAME')).toEqual(resolveSheetSku('ECHOBARRIER V2 FRAME'))
  })

  it('is insensitive to case and to the spacing the sheets vary on', () => {
    expect(resolveSheetSku('  echobarrier   h9  green ')).toEqual({ ok: true, sku: 'EBH9NA' })
    expect(resolveSheetSku('h9g')).toEqual({ ok: true, sku: 'EBH9NA' })
  })
})

describe('resolveSheetSku refuses rather than guessing', () => {
  it('refuses the plain fitting kit, which has no North America SKU', () => {
    const r = resolveSheetSku('FK-0001')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('vertical kit')
    // The vertical kit is a different product and DOES map.
    expect(resolveSheetSku('EBVFK')).toEqual({ ok: true, sku: 'EBVFKNA' })
  })

  it('refuses the anti-theft cables, which have no SKU at all', () => {
    for (const part of ['ATC-0012', 'ATC-0023', 'ATC-0040', 'ECHOBARRIER ATC 12']) {
      expect(resolveSheetSku(part).ok).toBe(false)
    }
  })

  it('refuses an unknown part number with the number in the reason', () => {
    const r = resolveSheetSku('WIDGET-9000')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('WIDGET-9000')
  })

  it('refuses a blank', () => {
    expect(resolveSheetSku('').ok).toBe(false)
    expect(resolveSheetSku('   ').ok).toBe(false)
  })
})

describe('Canada coverage', () => {
  // A CAD price on an unmapped SKU quotes fine and then cannot resolve a Xero
  // item at invoicing, which is a worse failure than refusing it now.
  it('refuses a Canadian price on a SKU with no CA-HAM depot mapping', () => {
    expect(resolveSheetSku('H9X-0001', 'US')).toEqual({ ok: true, sku: 'EBH9XNA' })
    const ca = resolveSheetSku('H9X-0001', 'CA')
    expect(ca.ok).toBe(false)
    if (!ca.ok) expect(ca.reason).toContain('CA-HAM')
  })

  it('allows the SKUs Canada does carry', () => {
    expect(resolveSheetSku('H9-0001', 'CA')).toEqual({ ok: true, sku: 'EBH9NA' })
    expect(resolveSheetSku('H10-0001', 'CA')).toEqual({ ok: true, sku: 'EBH10NA' })
    expect(resolveSheetSku('HK-0001', 'CA')).toEqual({ ok: true, sku: 'HKNA' })
    expect(resolveSheetSku('H10B', 'CA')).toEqual({ ok: true, sku: 'EBH10HERC' })
  })
})

describe('the mapping itself', () => {
  // Nothing in the codebase prefix-matches a SKU today, and this keeps it that
  // way: if a part number ever became a prefix of another, a future LIKE lookup
  // would silently mis-hit.
  it('has no part number that is a prefix of another', () => {
    const parts = ['H8-0001', 'H9-0001', 'H9X-0001', 'H10-0001', 'H9G', 'H10G', 'H9XG', 'H10B']
    const collisions = parts.flatMap((a) =>
      parts.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a} is a prefix of ${b}`),
    )
    expect(collisions).toEqual([])
  })

  it('only ever produces SKUs that exist in HubSpot', () => {
    // Verified live on 2026-09-04 by paging all 274 HubSpot products.
    const inHubSpot = new Set([
      'EBH8NA', 'EBH9NA', 'EBH9XNA', 'EBH10NA', 'EBH10HERC', 'CCSNA', 'FSCNA',
      'V2NA', 'M1NA', 'HKNA', 'BUNNA', 'EBVFKNA', 'LTLNA', 'EBH9WNA', 'EBH9ERNA',
    ])
    for (const sku of mappedSkus()) expect(inHubSpot.has(sku), `${sku} is not a HubSpot product`).toBe(true)
  })
})
