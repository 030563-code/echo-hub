/**
 * The places stock can sit, as the stock board and the ledger know them.
 *
 * `warehouse_code` on warehouse_stock_levels IS the depot code (receive-po
 * passes the depot leg's from_entity straight through), so these are the same
 * strings the PO chain carries. EB-SRO is the s.r.o. warehouse in Kosice; the
 * other three are the North American depots.
 */

export const SRO_WAREHOUSE = 'EB-SRO'

export const DEPOT_WAREHOUSES = ['US-BAL', 'US-SBD', 'CA-HAM'] as const
export type DepotWarehouse = (typeof DEPOT_WAREHOUSES)[number]

export const STOCK_WAREHOUSES = [SRO_WAREHOUSE, ...DEPOT_WAREHOUSES] as const
export type StockWarehouse = (typeof STOCK_WAREHOUSES)[number]

export function isStockWarehouse(code: string): code is StockWarehouse {
  return (STOCK_WAREHOUSES as readonly string[]).includes(code)
}

/**
 * Where a container can land. Every regional depot the chain and the ledger
 * know, and nothing else: EB-SRO is where it leaves from, and EB-GROUP is the
 * intercompany buffer it passes through on paper. Dean, 21 Sep 2026: "when
 * they arrive at shipment in US/UK/Fr all these depots it should decrement
 * from SRO stock and into those depot stock".
 *
 * Deliberately not DEPOT_WAREHOUSES: the /mrp board sums that list as one
 * North American on-hand figure, and widening it would fold UK and French
 * shelves into a US number.
 */
export const ARRIVAL_DEPOTS = ['US-BAL', 'US-SBD', 'CA-HAM', 'GB-BSE', 'EU-FR', 'AU-SYD'] as const
export type ArrivalDepot = (typeof ARRIVAL_DEPOTS)[number]

export function isArrivalDepot(code: string): code is ArrivalDepot {
  return (ARRIVAL_DEPOTS as readonly string[]).includes(code)
}

/** A count older than this is shown as stale rather than fresh. */
export const STALE_COUNT_DAYS = 90
