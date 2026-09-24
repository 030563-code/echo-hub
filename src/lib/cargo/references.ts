/**
 * Small rules for shipments added by hand and the references kept on them. No I/O, so the board,
 * the actions and the tests share one reading of what a SPOT ID and a reference are.
 */

/** A SPOT ID as Cargo Partner issues them: digits only, nine on every shipment seen so far. */
export function looksLikeSpotId(input: string): boolean {
  return /^[0-9]{6,12}$/.test(input.trim())
}

/** A reference as typed: trimmed, inner spaces collapsed, 1 to 80 characters. Null when it is not one. */
export function cleanReference(input: string): string | null {
  const value = input.trim().replace(/\s+/g, ' ')
  return value.length >= 1 && value.length <= 80 ? value : null
}

/** Dave's sheet order numbers for one shipment (order_no, order_no_local), each once, in order. */
export function sheetReferenceList(rows: readonly { order_no: string | null; order_no_local: string | null }[]): string[] {
  const seen: string[] = []
  for (const row of rows) {
    for (const value of [row.order_no, row.order_no_local]) {
      const clean = value ? cleanReference(value) : null
      if (clean && !seen.includes(clean)) seen.push(clean)
    }
  }
  return seen
}

/**
 * Which SPOT IDs a scheduled refresh fetches: every one not yet stored, and every stored one still
 * moving. A finished journey does not change, so asking Cargo Partner about it again is waste.
 */
export function spotIdsToRefresh(known: readonly string[], finished: ReadonlySet<string>): string[] {
  return known.filter((id) => !finished.has(id))
}

/** Whether a board row answers what was typed in the search box. */
export function matchesSearch(
  row: {
    /** Null for a shipment kept by hand until Cargo Partner books it. */
    spotId: string | null
    generalReference: string | null
    vesselName: string | null
    oceanCarrier: string | null
    destinationCity: string | null
    destinationDepot: string | null
    cargoDescription: string | null
    containerNumbers: readonly string[]
    references: readonly string[]
    /** What is on it ("560 × H10HERCB"), so a product code finds the containers carrying it. */
    contents?: string | null
  },
  needle: string,
): boolean {
  const n = needle.trim().toLowerCase()
  if (!n) return true
  return [
    row.spotId,
    row.generalReference,
    row.vesselName,
    row.oceanCarrier,
    row.destinationCity,
    row.destinationDepot,
    row.cargoDescription,
    ...row.containerNumbers,
    ...row.references,
    row.contents,
  ]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(n))
}
