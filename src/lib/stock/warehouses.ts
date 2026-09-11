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

/** A count older than this is shown as stale rather than fresh. */
export const STALE_COUNT_DAYS = 90
