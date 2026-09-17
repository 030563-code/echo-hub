/**
 * The organisation dimension of the Stock Prediction Engine.
 *
 * Demand is computed per organisation and never pooled across them. A UK ADU and a US ADU are
 * different numbers for the same SKU: the UK is hire-led and roughly an order of magnitude
 * larger, and migration 20260808000300 carries that as a written contract. This module holds the
 * keying and the depot mapping so neither is reinvented at three call sites.
 */

/** The seven Echo Barrier companies, as entities.code spells them. */
export const ORGANISATIONS = [
  "EB-USA",
  "EB-CANADA",
  "EB-UK",
  "EB-FRANCE",
  "EB-AUSTRALIA",
  "EB-GROUP",
  "EB-SRO",
] as const;

export type Organisation = (typeof ORGANISATIONS)[number];

/**
 * The organisation a buffer belongs to when nothing says otherwise.
 *
 * Every profile row that existed before the per-organisation migration was seeded from
 * region in ('US','CA') and treated by the engine as one pooled North American market, so they
 * carry EB-USA. New organisations get their own rows rather than inheriting this.
 */
export const DEFAULT_ORGANISATION: Organisation = "EB-USA";

/**
 * Which company's stock sits in which depot.
 *
 * 🔴 Only the North American depots and the factory have a stock feed in the Hub today
 * (warehouse_stock_levels holds US-BAL, US-SBD, CA-HAM and EB-SRO and nothing else). UK, France
 * and Australia levels live in xero_stock_snapshot, which the engine does not read yet. So this
 * map is complete as a statement of intent and incomplete as a statement of available data, and
 * `organisationsWithStock` is the honest list.
 */
export const DEPOT_ORGANISATION: Record<string, Organisation> = {
  "US-BAL": "EB-USA",
  "US-SBD": "EB-USA",
  "CA-HAM": "EB-CANADA",
  "EB-SRO": "EB-SRO",
  "EU-SK": "EB-SRO",
  "EU-FR": "EB-FRANCE",
  "GB-BSE": "EB-UK",
  "AU-SYD": "EB-AUSTRALIA",
};

/** The organisation that owns a depot, or null when the code is not one we know. */
export function organisationForDepot(code: string | null | undefined): Organisation | null {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return null;
  return DEPOT_ORGANISATION[trimmed] ?? null;
}

/**
 * The composite key the engine buckets by, now that a SKU alone no longer identifies a buffer.
 *
 * The separator is a pipe because no organisation code or SKU contains one: organisation codes
 * are from a fixed list and SKUs are alphanumeric with hyphens and dots.
 */
export function demandKey(organisation: string, sku: string): string {
  return `${organisation}|${sku}`;
}

/** Split a key made by `demandKey` back into its parts. */
export function splitDemandKey(key: string): { organisation: string; sku: string } {
  const at = key.indexOf("|");
  if (at < 0) return { organisation: DEFAULT_ORGANISATION, sku: key };
  return { organisation: key.slice(0, at), sku: key.slice(at + 1) };
}

/**
 * The organisations the engine can currently produce an actionable net flow position for.
 *
 * An organisation needs BOTH demand history and a stock feed to be worth running: demand alone
 * gives a buffer size with nothing to compare it against.
 *
 * Six of the seven qualify since the stock consolidation (migrations 20260917210000 and
 * 20260917220000): warehouse_stock_levels is now the single source of truth and carries all seven
 * depots, the North American and factory levels from physical counts and the UK, France and Group
 * levels synced from their Xero item ledgers.
 *
 * EB-AUSTRALIA is the exception and it is genuine, not an oversight. Dean, 17 Sep 2026:
 * "Australia is empty at the moment as we are building it up again."
 */
export const ORGANISATIONS_WITH_STOCK: readonly Organisation[] = [
  "EB-USA",
  "EB-CANADA",
  "EB-SRO",
  "EB-UK",
  "EB-FRANCE",
  "EB-GROUP",
];
