/**
 * The organisations: Echo Barrier's seven Xero companies, and how each module's
 * own region column maps onto them.
 *
 * Dean, 15 Sep 2026: "a dropdown under each section ... USA, CANADA, FRANCE,
 * SRO, GROUP, AUSTRALIA, UK etc all the organisations we have in Xero atm ...
 * Jillian can only see USA Claire only France but Dave all of them."
 *
 * Before this the Hub scoped rows by one field, profiles.pipeline_id, and only
 * Quotes and Calls used it; every other module showed everyone everything once
 * they held the capability. The organisation is now the OUTER scope for every
 * module. Which organisations a person holds is a row per organisation in
 * user_organisations (super admins hold all, as they hold every capability).
 * Which one they are looking at is the hub_org cookie, read by
 * activeOrganisation() in active-organisation.server.ts. Each module turns that
 * into its own predicate through the helpers below, IN THE QUERY: a scope that
 * is only a check is not a scope.
 *
 * Keyed by entities.code on purpose. The Hub already carried depot codes,
 * entity codes and PO prefixes for the same companies, and a fourth vocabulary
 * would be one more thing to translate. The labels are Dean's words.
 *
 * WHOLE pipelines and WHOLE offices, never a split of one. Canada has no
 * pipeline or phone office of its own: its quotes are in USA SALES and its
 * calls come to the USA office, "same as in hubspot" (Dean, 15 Sep 2026), so
 * USA and Canada map to the same pipeline and the same office, and that is
 * normal rather than a mistake.
 *
 * Pure: no server-only import and no database. The sidebar and the pages both
 * read it, and tests/unit/organisations.test.ts pins every mapped value to one
 * that exists in the list it comes from.
 */

import type { FlagCode } from '@/components/ui/flag-icon'
import { OFFICES, type Office } from '@/lib/calls/offices'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

export const ORGANISATIONS = [
  { code: 'EB-USA', label: 'USA', legalName: 'Echo Barrier USA LLC', currency: 'USD', flag: 'US' },
  { code: 'EB-CANADA', label: 'Canada', legalName: 'Echo Barrier Canada, Inc', currency: 'CAD', flag: 'CA' },
  { code: 'EB-FRANCE', label: 'France', legalName: 'Echo Barrier France', currency: 'EUR', flag: 'FR' },
  { code: 'EB-SRO', label: 'SRO', legalName: 'Echo Barrier s.r.o.', currency: 'EUR', flag: 'SK' },
  // The registered address is Dublin, hence the Irish flag. Dean to confirm;
  // the Xero tenant lists the company as UK.
  { code: 'EB-GROUP', label: 'Group', legalName: 'Echo Barrier Group Limited', currency: 'EUR', flag: 'IE' },
  { code: 'EB-AUSTRALIA', label: 'Australia', legalName: 'Echo Barrier Australia Pty Ltd', currency: 'AUD', flag: 'AU' },
  { code: 'EB-UK', label: 'UK', legalName: 'Echo Barrier Limited', currency: 'GBP', flag: 'GB' },
] as const

export type OrgCode = (typeof ORGANISATIONS)[number]['code']

export interface Organisation {
  /** entities.code, the primary key of the registry table. */
  code: OrgCode
  /** What people call it. Dean's list, spelled his way. */
  label: string
  /** The legal name in Xero. */
  legalName: string
  /** The currency its prices, invoices and Xero organisation run in. */
  currency: string
  flag: FlagCode
}

/** The same list, typed: the compiler checks every entry is a whole
 *  Organisation with a flag the icon can draw. */
const REGISTRY: readonly Organisation[] = ORGANISATIONS

export const ORG_CODES: readonly OrgCode[] = REGISTRY.map((o) => o.code)

export function isOrgCode(value: unknown): value is OrgCode {
  return typeof value === 'string' && (ORG_CODES as readonly string[]).includes(value)
}

export function organisation(code: OrgCode): Organisation {
  // The list is closed and the code is typed, so this always finds one.
  return REGISTRY.find((o) => o.code === code) as Organisation
}

/** "USA", "Canada", ... An unknown code passes through rather than becoming
 *  "Unknown", because a code somebody recognises beats a word that tells them
 *  nothing (the same contract as depotLabel). */
export function orgLabel(code: string | null | undefined): string {
  return isOrgCode(code) ? organisation(code).label : String(code ?? '')
}

/** Keeps a list of codes in registry order and drops anything that is not one. */
export function sortOrgs(codes: readonly string[]): OrgCode[] {
  return ORG_CODES.filter((code) => codes.includes(code))
}

/** True when `org` is one of `held`. The one test every write gate asks. */
export function holdsOrganisation(held: readonly OrgCode[], org: string | null | undefined): org is OrgCode {
  return isOrgCode(org) && held.includes(org)
}

// ---------------------------------------------------------------------------
// The mappings. One record per dimension, every organisation present, so a
// new organisation cannot be added to the list above without the compiler
// asking what it means for each module.
// ---------------------------------------------------------------------------

/**
 * The HubSpot sales pipeline whose deals belong to the organisation, or null
 * when it sells nothing through the Hub (s.r.o. manufactures).
 *
 * Whole pipelines. Two organisations may share one (USA and Canada), and a
 * pipeline is never split by depot or currency between two organisations.
 * INTERNATIONAL SALES to Group and SRO having no pipeline are Dean's to
 * confirm.
 */
const QUOTES_PIPELINE: Record<OrgCode, string | null> = {
  'EB-USA': HUBSPOT_PIPELINES.USA_SALES.id,
  'EB-CANADA': HUBSPOT_PIPELINES.USA_SALES.id,
  'EB-FRANCE': HUBSPOT_PIPELINES.EURO_SALES.id,
  'EB-SRO': null,
  'EB-GROUP': HUBSPOT_PIPELINES.INTERNATIONAL_SALES.id,
  'EB-AUSTRALIA': HUBSPOT_PIPELINES.AUSTRALIA_SALES.id,
  'EB-UK': HUBSPOT_PIPELINES.UK_SALES_NEW.id,
}

/**
 * The depots the organisation ships from. This is the dimension the invoicing
 * queue (deals_registry.depot_code), the purchase-order chain
 * (from_entity/to_entity) and transport (shipment_contents.depot_destination)
 * all carry. Group owns no depot: it is the company in the middle of every
 * chain.
 */
const DEPOTS: Record<OrgCode, readonly string[]> = {
  'EB-USA': ['US-BAL', 'US-SBD'],
  'EB-CANADA': ['CA-HAM'],
  'EB-FRANCE': ['EU-FR'],
  'EB-SRO': ['EU-SK'],
  'EB-GROUP': [],
  'EB-AUSTRALIA': ['AU-SYD'],
  'EB-UK': ['GB-BSE'],
}

/**
 * The phone-system offices whose calls the organisation takes. Whole offices,
 * as HubSpot has them: Canada's calls come to the USA office. Spain to France
 * and Asia to Group are Dean's to confirm.
 */
const CALL_OFFICES: Record<OrgCode, readonly Office[]> = {
  'EB-USA': ['USA'],
  'EB-CANADA': ['USA'],
  'EB-FRANCE': ['France', 'Spain'],
  'EB-SRO': [],
  'EB-GROUP': ['Asia'],
  'EB-AUSTRALIA': ['ANZ'],
  'EB-UK': ['UK'],
}

/** The stock-board warehouses the organisation holds. warehouse_code IS the
 *  depot code for the depots, and EB-SRO for the factory warehouse in Kosice. */
const WAREHOUSES: Record<OrgCode, readonly string[]> = {
  'EB-USA': ['US-BAL', 'US-SBD'],
  'EB-CANADA': ['CA-HAM'],
  'EB-FRANCE': [],
  'EB-SRO': ['EB-SRO'],
  'EB-GROUP': [],
  'EB-AUSTRALIA': [],
  'EB-UK': [],
}

/** Every container leaves s.r.o. and is owned by Group on the way, so those two
 *  see all of transport; a depot's organisation sees what is coming to it. */
const TRANSPORT_SEES_ALL: readonly OrgCode[] = ['EB-SRO', 'EB-GROUP']

export function pipelineForOrg(code: OrgCode): string | null {
  return QUOTES_PIPELINE[code]
}

/** The organisations a HubSpot pipeline belongs to. Empty for a pipeline
 *  nobody has mapped (DEMO, the hire pipelines). */
export function orgsForPipeline(pipelineId: string | null | undefined): OrgCode[] {
  const id = String(pipelineId ?? '').trim()
  if (id === '') return []
  return ORG_CODES.filter((code) => QUOTES_PIPELINE[code] === id)
}

export function depotsForOrg(code: OrgCode): readonly string[] {
  return DEPOTS[code]
}

/** The organisation a depot belongs to, or null for a code nobody has mapped. */
export function orgForDepot(depot: string | null | undefined): OrgCode | null {
  const value = String(depot ?? '').trim().toUpperCase()
  if (value === '') return null
  return ORG_CODES.find((code) => DEPOTS[code].includes(value)) ?? null
}

export function officesForOrg(code: OrgCode): readonly Office[] {
  return CALL_OFFICES[code]
}

/** The offices of several organisations together, in OFFICES order and without
 *  repeats. What a write gate checks a call against: a person may act on any
 *  call they can see, whichever organisation they happen to be looking at. */
export function officesForOrgs(codes: readonly OrgCode[]): Office[] {
  const all = new Set<Office>()
  for (const code of codes) for (const office of CALL_OFFICES[code]) all.add(office)
  return OFFICES.filter((office) => all.has(office))
}

export function currenciesForOrg(code: OrgCode): readonly string[] {
  return [organisation(code).currency]
}

/** The currencies of several organisations together, without repeats. */
export function currenciesForOrgs(codes: readonly OrgCode[]): string[] {
  return Array.from(new Set(codes.map((code) => organisation(code).currency)))
}

export function warehousesForOrg(code: OrgCode): readonly string[] {
  return WAREHOUSES[code]
}

/** The codes a purchase-order leg can carry in from_entity or to_entity that
 *  make it the organisation's: the company itself and its depots. */
export function partiesForOrg(code: OrgCode): readonly string[] {
  return [code, ...DEPOTS[code]]
}

export function transportSeesAll(code: OrgCode): boolean {
  return TRANSPORT_SEES_ALL.includes(code)
}

/** True when any of the organisations held sees every container. */
export function transportSeesAllFor(held: readonly OrgCode[]): boolean {
  return held.some(transportSeesAll)
}

/** The depots of several organisations together, without repeats. */
export function depotsForOrgs(codes: readonly OrgCode[]): string[] {
  return Array.from(new Set(codes.flatMap((code) => DEPOTS[code])))
}

/** The warehouses of several organisations together, without repeats. */
export function warehousesForOrgs(codes: readonly OrgCode[]): string[] {
  return Array.from(new Set(codes.flatMap((code) => WAREHOUSES[code])))
}

/** The purchase-order parties of several organisations together. */
export function partiesForOrgs(codes: readonly OrgCode[]): string[] {
  return Array.from(new Set(codes.flatMap((code) => partiesForOrg(code))))
}

/**
 * True when any leg of a purchase-order chain names a party of one of the
 * organisations held. A chain is seen whole by every organisation with a leg
 * in it: a USA order's Group and s.r.o. legs are still that order.
 */
export function chainTouchesOrgs(
  legs: readonly { from_entity: string | null; to_entity: string | null }[],
  held: readonly OrgCode[],
): boolean {
  const parties = new Set(partiesForOrgs(held))
  return legs.some(
    (leg) =>
      (leg.from_entity !== null && parties.has(leg.from_entity)) ||
      (leg.to_entity !== null && parties.has(leg.to_entity)),
  )
}

// ---------------------------------------------------------------------------
// Which organisations each module has anything for. This is what decides the
// sub-list under a sidebar item, and what a page checks before it queries: an
// organisation a module knows nothing about gets a plain "nothing here for
// France" rather than everything.
// ---------------------------------------------------------------------------

export const ORG_MODULES = [
  'quotes',
  'invoicing',
  'pricing',
  'calls',
  'purchase-orders',
  'stock',
  'transport',
  'invoices',
] as const

export type OrgModule = (typeof ORG_MODULES)[number]

export const MODULE_ORGS: Record<OrgModule, readonly OrgCode[]> = {
  quotes: ORG_CODES.filter((code) => QUOTES_PIPELINE[code] !== null),
  // Every organisation, Dean's decision of 15 Sep 2026: the structure now, with
  // USA the only one whose tax and Xero flow exists. The others show their
  // queue and refuse to create an invoice until their flow is built.
  invoicing: ORG_CODES,
  pricing: ORG_CODES,
  calls: ORG_CODES.filter((code) => CALL_OFFICES[code].length > 0),
  'purchase-orders': ORG_CODES,
  stock: ORG_CODES.filter((code) => WAREHOUSES[code].length > 0),
  transport: ORG_CODES,
  invoices: ORG_CODES,
}

export function moduleHasOrg(module: OrgModule, code: OrgCode): boolean {
  return MODULE_ORGS[module].includes(code)
}

/** The organisations to list under a sidebar item for this person: the ones
 *  the module has anything for, that they hold, in registry order. */
export function orgsForNavItem(module: OrgModule | undefined, held: readonly OrgCode[]): OrgCode[] {
  if (!module) return []
  return MODULE_ORGS[module].filter((code) => held.includes(code))
}
