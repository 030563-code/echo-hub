/**
 * The shipment request Cargo Partner are asked to act on.
 *
 * Plain module, not server-only: the review screen needs the same field list and
 * the same allowed values as the server that validates them, and a dropdown that
 * disagrees with its validator is a dropdown that produces errors nobody can fix.
 *
 * The allowed values are taken from Cargo Partner's own published Transport
 * specification (swagger.test.cargo-partner.com/transport/v1), not invented, so
 * an approved request already carries values their API will accept when the
 * booking leg is switched on. Nothing here calls that API.
 */

/** Barriers per pallet. The same figure the Bamida purchase order is built on. */
export const PALLET_SIZE = 70

/**
 * Incoterms, exactly as the spec spells them (TransportDeliveryTerm.deliveryTerm).
 * Null is a real answer here and the default one: the term for the SRO to depot
 * leg is recorded nowhere in the Hub, and inventing one quietly decides who pays
 * for the freight.
 */
export const INCOTERMS = [
  'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP',
  'DAF', 'DES', 'DEQ', 'DDU', 'DDP', 'DAP', 'DAT',
] as const

export const MODALITIES = ['SEA', 'AIR', 'ROAD', 'RAIL', 'SEA_AIR', 'AIR_SEA'] as const
export const CATEGORIES = ['FCL', 'LCL', 'FTL', 'LTL', 'GROUPAGE', 'REEFER'] as const
export const DIRECTIONS = ['EXPORT', 'IMPORT', 'TRIANGLE'] as const

/**
 * The spec does not enumerate package types, so this is a short list of what we
 * actually ship on rather than a constraint borrowed from somewhere.
 */
export const PACKAGE_TYPES = ['PAL', 'BOX', 'CRT', 'CTN', 'PCE'] as const

/**
 * The narrow types matter: the same lists validate the request on the server,
 * so a screen that can produce a value the validator rejects is a screen that
 * produces errors nobody can act on.
 */
export type Incoterm = (typeof INCOTERMS)[number]
export type Modality = (typeof MODALITIES)[number]
export type Category = (typeof CATEGORIES)[number]
export type Direction = (typeof DIRECTIONS)[number]
export type PackageType = (typeof PACKAGE_TYPES)[number]

/**
 * The three fixed parties, as they are recorded against real shipments in
 * `shipments.shipment_details -> participants`. Account numbers are what Cargo
 * Partner index on, so they matter more than the addresses. Constants rather
 * than a lookup: they are three standing commercial relationships, and a query
 * here would be a query that can fail on the path that must not fail.
 */
export const SHIPPER = {
  name: 'Echo Barrier s.r.o.',
  account: '446813',
  address: ['Sturova 3/6', '040 01 Kosice', 'Slovakia'],
} as const

export const PICKUP = {
  name: 'BAMIDA, s.r.o.',
  account: '604070',
  address: ['Kosicka 28', '080 01 Presov', 'Slovakia'],
} as const

/**
 * Who the barriers are collected FROM, which is not always Bamida.
 *
 * Dean, 9 Sep 2026: an SRO order fulfilled from stock needs the same shipment
 * request as a manufactured one. Those barriers are already on Echo Barrier's
 * own shelf in Kosice, so the freight is collected from us, not from the
 * factory in Presov. Everything else about the request is identical.
 */
export const PICKUP_PARTIES = {
  BAMIDA: PICKUP,
  EB_SRO: SHIPPER,
} as const

/** The narrow list, so the validator and the draft cannot drift apart. */
export const PICKUP_FROM = ['BAMIDA', 'EB_SRO'] as const
export type PickupFrom = (typeof PICKUP_FROM)[number]

export const OFFICE_IN_CHARGE = {
  name: 'cargo-partner SR, Kosice',
  account: '139461',
  role: 'CONTROLLING_AGENT',
} as const

/**
 * Dean, 9 Sep: no SKU. `EBH9NA` is our own database code and means nothing to a
 * freight forwarder, so it is not carried here and cannot reach the email.
 */
export type CargoLine = {
  product_name: string | null
  product_family: string | null
  quantity: number | null
}

export type CargoDraftLine = CargoLine & { pallets: number }

/** Everything a person may change before the request leaves the building. */
export type CargoDraft = {
  general_reference: string
  /** Which door the truck goes to. Bamida for a made order, EB SRO for stock. */
  pickup_from: PickupFrom
  cargo_readiness_date: string
  main_modality: Modality
  main_category: Category
  business_direction: Direction
  delivery_term: Incoterm | null
  pieces: number
  package_type_code: PackageType
  description: string
  consignee_name: string
  consignee_address: string
  notes: string
  /** Who it goes to. The Hub decides recipients; a person choosing one here IS the Hub. */
  to: string
  cc: string
  lines: CargoDraftLine[]
}

/** Pallets for one quantity. A part pallet still takes a pallet. */
export function palletsForQuantity(quantity: number | null | undefined): number {
  const qty = Number(quantity ?? 0)
  return qty > 0 ? Math.ceil(qty / PALLET_SIZE) : 0
}

/** Pallets across the order, rounded up per line. */
export function palletsFor(lines: readonly CargoLine[]): number {
  let pallets = 0
  for (const line of lines) pallets += palletsForQuantity(line.quantity)
  return pallets
}

/** "Acoustic Barriers H9, H10", or just "Acoustic Barriers" when nothing is named. */
export function cargoDescription(lines: readonly CargoLine[]): string {
  const models = Array.from(
    new Set(lines.map((l) => (l.product_family ?? '').trim()).filter(Boolean)),
  ).sort()
  return models.length ? `Acoustic Barriers ${models.join(', ')}` : 'Acoustic Barriers'
}

/**
 * The first version of the request, built when Bamida say the barriers are
 * ready. Everything in it is a starting point a person may correct, which is
 * the whole reason the draft exists rather than an email leaving on its own.
 */
export function buildCargoDraft(input: {
  poNumber: string | null
  finishedAt: string
  lines: readonly CargoLine[]
  consignee: { depot: string | null; address: string | null }
  to: string
  cc: string
  /** Defaults to the factory, because that is where most orders come from. */
  pickupFrom?: PickupFrom
}): CargoDraft {
  return {
    general_reference: input.poNumber ?? '',
    pickup_from: input.pickupFrom ?? 'BAMIDA',
    cargo_readiness_date: input.finishedAt.slice(0, 10),
    main_modality: 'SEA',
    main_category: 'FCL',
    business_direction: 'EXPORT',
    delivery_term: null,
    pieces: palletsFor(input.lines),
    package_type_code: 'PAL',
    description: cargoDescription(input.lines),
    consignee_name: input.consignee.depot ?? '',
    consignee_address: input.consignee.address ?? '',
    notes: '',
    to: input.to,
    cc: input.cc,
    lines: input.lines.map((line) => ({
      product_name: line.product_name,
      product_family: line.product_family,
      quantity: line.quantity,
      pallets: palletsForQuantity(line.quantity),
    })),
  }
}
