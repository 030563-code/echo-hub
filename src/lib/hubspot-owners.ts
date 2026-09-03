/**
 * Turning HubSpot owner and team ids into names a person can read.
 *
 * Dean asked that Dave "view all the deals in Hubspot where it also shows the
 * hubspot team pipeline associated with it". A deal carries hubspot_owner_id
 * and hubspot_team_id, both opaque numbers, and this portal's private-app token
 * gets 403 on settings/v3/users (probed 2026-09-02), so GET /crm/v3/owners is
 * the only route to the names. One call per render is indexed here and reused
 * for every row.
 *
 * Pure: the fetch lives in the server action beside it. Nothing in a HubSpot
 * payload is trusted to be present, because it is not: some owners carry no
 * teams array, some an empty one, some several with exactly one primary, and a
 * few have no name at all.
 */

/** The app's own "nothing here" glyph, matching depotLabel and formatMoney in
 *  src/lib/depot-constants.ts and src/lib/utils.ts. */
const PLACEHOLDER = '—'

export interface HubSpotOwner {
  id?: string | number | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  archived?: boolean | null
  teams?: { id?: string | number | null; name?: string | null; primary?: boolean | null }[] | null
}

export interface OwnerIndex {
  ownerNameById: Record<string, string>
  teamNameById: Record<string, string>
  /** For showing a deal's team when the deal itself carries none. */
  primaryTeamIdByOwnerId: Record<string, string>
}

/** HubSpot returns owner ids as strings and team ids as numbers in the same
 *  payload, so everything is keyed as a string. */
function key(value: string | number | null | undefined): string {
  return String(value ?? '').trim()
}

function displayName(owner: HubSpotOwner, id: string): string {
  const name = [owner.firstName, owner.lastName]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
  if (name !== '') return name
  const email = String(owner.email ?? '').trim()
  if (email !== '') return email
  // Never blank. A rep recognises the raw id from a HubSpot URL, which beats
  // an empty cell or the word "Unknown" sitting where a colleague's name goes.
  return `Owner ${id}`
}

/**
 * Index one owners payload.
 *
 * ARCHIVED OWNERS ARE KEPT. A deactivated rep's deals do not disappear, they
 * still point at that owner id, and the name is the whole reason the column
 * exists. Filtering them out would blank exactly the rows that need explaining.
 *
 * Never throws: a null payload, a member with no id, a teams entry with no id
 * are all skipped rather than allowed to take a page down over a display name.
 */
export function indexOwners(results: readonly HubSpotOwner[] | null | undefined): OwnerIndex {
  const ownerNameById: Record<string, string> = {}
  const teamNameById: Record<string, string> = {}
  const primaryTeamIdByOwnerId: Record<string, string> = {}

  for (const owner of results ?? []) {
    if (!owner) continue
    const id = key(owner.id)
    if (id === '') continue
    ownerNameById[id] = displayName(owner, id)

    const teams = Array.isArray(owner.teams) ? owner.teams : []
    for (const team of teams) {
      if (!team) continue
      const teamId = key(team.id)
      if (teamId === '') continue
      const name = String(team.name ?? '').trim()
      if (name !== '') teamNameById[teamId] = name
      // First team wins when none is flagged primary, so an owner with exactly
      // one team still resolves.
      if (team.primary === true || primaryTeamIdByOwnerId[id] === undefined) {
        primaryTeamIdByOwnerId[id] = teamId
      }
    }
  }

  return { ownerNameById, teamNameById, primaryTeamIdByOwnerId }
}

/** The owner cell for a deal row. */
export function ownerLabel(index: OwnerIndex, ownerId: string | null | undefined): string {
  const id = key(ownerId)
  if (id === '') return PLACEHOLDER
  return index.ownerNameById[id] ?? `Owner ${id}`
}

/**
 * The team cell for a deal row, falling back to the owner's primary team.
 *
 * Deals synced before HubSpot started stamping hubspot_team_id carry none, and
 * the owner's own team is the right answer for those rather than a blank.
 */
export function teamLabel(
  index: OwnerIndex,
  teamId: string | null | undefined,
  ownerId?: string | null,
): string {
  const direct = key(teamId)
  if (direct !== '') return index.teamNameById[direct] ?? `Team ${direct}`
  const owner = key(ownerId)
  const derived = owner === '' ? '' : key(index.primaryTeamIdByOwnerId[owner])
  if (derived === '') return PLACEHOLDER
  return index.teamNameById[derived] ?? `Team ${derived}`
}
