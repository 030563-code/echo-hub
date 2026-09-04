/**
 * Turning a price sheet's part number into the HubSpot SKU the Hub prices on.
 *
 * The sheets speak three different languages and none of them is the HubSpot
 * SKU. The Echo Barrier list uses its own part numbers ("H9-0001"), Herc uses
 * short codes ("H9G"), and United Rentals, HERMEQ and SunBelt spell the product
 * out ("ECHOBARRIER H9 GREEN"). The Hub prices on hubspot_sku_code, so every
 * row has to be translated before it can be loaded.
 *
 * Pure and exhaustively tested on purpose. A wrong entry here does not throw,
 * it quietly charges a customer the price of a different product.
 *
 * THE RULE FOR ANYTHING UNKNOWN IS TO REFUSE, NOT TO GUESS. resolveSheetSku
 * returns an `unmapped` reason for a part number it does not recognise, the
 * loader prints those, and it will not commit while any remain.
 */

/** Every HubSpot SKU below was verified to exist as a real HubSpot product on
 *  2026-09-04 by paging all 274 products in the portal. */
export type SheetRegion = 'US' | 'CA'

export type SheetSkuResult = { ok: true; sku: string } | { ok: false; reason: string }

/** Case, spacing and punctuation vary wildly between sheets and between rows of
 *  the same sheet, so everything is compared on a squashed upper-case form. */
function key(partNumber: string): string {
  return String(partNumber ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/**
 * Part number to HubSpot SKU.
 *
 * One flat map rather than one per sheet: the same product is spelled several
 * ways across sheets and they never conflict, so a single table is both simpler
 * and impossible to get inconsistent between contractors.
 */
const SKU_BY_PART_NUMBER: Record<string, string> = {
  // --- Echo Barrier's own list (general US, general Canada, ZnD) ---
  'H8-0001': 'EBH8NA',
  'H9-0001': 'EBH9NA',
  'H9X-0001': 'EBH9XNA',
  'H10-0001': 'EBH10NA',
  'CSC-0001': 'CCSNA',
  'CS-0001': 'FSCNA',
  // The part number says V1FF and the description says "V2 Accoustical
  // Barrier". The description wins: the only V-frame SKU in North America is
  // V2NA, and product_code_master lists V1 with no US or Canada item code at
  // all, so V1FF-0001 cannot mean a V1.
  'V1FF-0001': 'V2NA',
  'M1-0001': 'M1NA',
  'VK-0001': 'EBVFKNA',
  'HK-0001': 'HKNA',
  'BG-0001': 'BUNNA',

  // --- Herc's short codes ---
  H9G: 'EBH9NA',
  H10G: 'EBH10NA',
  H9XG: 'EBH9XNA',
  CCS: 'CCSNA',
  FSCS: 'FSCNA',
  V2: 'V2NA',
  // The black H10 carrying Herc's logo. EBH10HERC, not EBH10HERCNA: the NA
  // suffix would match every other North America SKU, but EBH10HERCNA is not a
  // HubSpot product (checked live across all 274), so nothing could be priced
  // against it. Dean confirmed EBH10HERC on 2026-09-04.
  H10B: 'EBH10HERC',

  // --- United Rentals, HERMEQ, SunBelt and White Cap spell it out ---
  'ECHOBARRIER H9 GREEN': 'EBH9NA',
  'ECHOBARRIER H10 GREEN': 'EBH10NA',
  'ECHOBARRIER H9X GREEN': 'EBH9XNA',
  'ECHOBARRIER H9X': 'EBH9XNA',
  'ECHOBARRIER CSC ENCLOSURE': 'CCSNA',
  'ECHOBARRIER CS ENCLOSURE': 'FSCNA',
  'ECHOBARRIER V2 FRAME': 'V2NA',
  // United Rentals' 2026 column renamed this to V1 FRAME while the 2025 column
  // and the description both say V2. Same product, same row.
  'ECHOBARRIER V1 FRAME': 'V2NA',

  // --- Accessories, spelled the same on every contractor sheet ---
  EBVFK: 'EBVFKNA',
  EBHOOK: 'HKNA',
  EBBUNG: 'BUNNA',
}

/**
 * Part numbers we deliberately refuse, with the reason a human needs.
 *
 * These are NOT oversights. Each one is a product on a price sheet that has no
 * North America HubSpot SKU behind it, so there is nothing to hang a price on.
 * Naming them here keeps them out of the loader's "unknown" pile, so a genuinely
 * new part number still stands out.
 */
const KNOWN_UNMAPPABLE: Record<string, string> = {
  'FK-0001':
    'the plain fitting kit has no North America SKU; only the vertical kit (EBVFKNA) is mapped',
  EBFK: 'the plain fitting kit has no North America SKU; only the vertical kit (EBVFKNA) is mapped',
  'ATC-0012': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ATC-0023': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ATC-0040': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ECHOBARRIER ATC 12': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ECHOBARRIER ATC 23': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ECHOBARRIER ATC 40': 'the anti-theft cables have no North America SKU in product_depot_mapping',
  'ECHOBARRIER H8 GREEN': 'H8 maps to EBH8NA but only at US depots; it has no CA-HAM mapping',
  'ECHOBARRIER H8': 'H8 maps to EBH8NA but only at US depots; it has no CA-HAM mapping',
}

/**
 * Which SKUs actually have a depot mapping in Canada, from
 * product_depot_mapping on 2026-09-04. A CAD price on anything else quotes
 * fine and then cannot resolve a Xero item at invoicing, so the loader is told
 * about it up front rather than discovering it on a real invoice.
 */
const CANADA_MAPPED_SKUS = new Set(['EBH9NA', 'EBH10NA', 'EBH10HERC', 'HKNA', 'BUNNA', 'LTLNA'])

export function resolveSheetSku(partNumber: string, region: SheetRegion = 'US'): SheetSkuResult {
  const k = key(partNumber)
  if (k === '') return { ok: false, reason: 'blank part number' }

  const refused = KNOWN_UNMAPPABLE[k]
  if (refused) return { ok: false, reason: refused }

  const sku = SKU_BY_PART_NUMBER[k]
  if (!sku) return { ok: false, reason: `no mapping for "${partNumber}"` }

  if (region === 'CA' && !CANADA_MAPPED_SKUS.has(sku)) {
    return {
      ok: false,
      reason: `${sku} has no CA-HAM depot mapping, so a Canadian price on it could not be invoiced`,
    }
  }

  return { ok: true, sku }
}

/** Every SKU this crosswalk can produce. Used by the loader to sanity-check
 *  against product_depot_mapping before writing anything. */
export function mappedSkus(): string[] {
  return [...new Set(Object.values(SKU_BY_PART_NUMBER))].sort()
}
