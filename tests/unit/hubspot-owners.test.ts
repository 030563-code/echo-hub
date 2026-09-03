import { describe, it, expect } from 'vitest'
import { indexOwners, ownerLabel, teamLabel, type HubSpotOwner } from '@/lib/hubspot-owners'

/** The shapes this portal actually returns, read live on 2026-09-02: 23 owners,
 *  team ids arriving as numbers while owner ids arrive as strings. */
const OWNERS: HubSpotOwner[] = [
  { id: '82370091', email: 'jillian.rocco@echobarrier.com', firstName: 'Jillian', lastName: 'Rocco', teams: [{ id: 949190, name: 'Echo Barrier USA sales', primary: true }] },
  { id: '85301222', email: 'dean@corserv.co.uk', firstName: 'Dean', lastName: 'Jeggles', teams: [] },
  { id: '11111', email: 'ops@echobarrier.com', teams: [{ id: '32677', name: 'Echo Barrier Europe' }, { id: '570270', name: 'France team', primary: true }] },
  { id: '22222', firstName: 'Archived', lastName: 'Rep', archived: true, teams: [{ id: 949190, name: 'Echo Barrier USA sales' }] },
  { id: '33333' },
]

describe('indexOwners', () => {
  const index = indexOwners(OWNERS)

  it('names an owner First Last, then email, then the raw id, but never blank', () => {
    expect(index.ownerNameById['82370091']).toBe('Jillian Rocco')
    expect(index.ownerNameById['11111']).toBe('ops@echobarrier.com')
    // A rep recognises the id from a HubSpot URL, which beats an empty cell.
    expect(index.ownerNameById['33333']).toBe('Owner 33333')
  })

  it('KEEPS archived owners, because their old deals still point at them', () => {
    // Filtering them out would blank exactly the rows that need explaining.
    expect(index.ownerNameById['22222']).toBe('Archived Rep')
  })

  it('collects team names across every owner, coercing numeric ids', () => {
    expect(index.teamNameById['949190']).toBe('Echo Barrier USA sales')
    expect(index.teamNameById['32677']).toBe('Echo Barrier Europe')
    expect(index.teamNameById['570270']).toBe('France team')
  })

  it('records the primary team, and the only team when none is flagged', () => {
    expect(index.primaryTeamIdByOwnerId['11111']).toBe('570270')
    expect(index.primaryTeamIdByOwnerId['82370091']).toBe('949190')
    expect(index.primaryTeamIdByOwnerId['85301222']).toBeUndefined()
  })

  it('never throws on a malformed payload', () => {
    // A display name is not worth taking a page down for.
    expect(() => indexOwners(null)).not.toThrow()
    expect(() => indexOwners(undefined)).not.toThrow()
    expect(indexOwners([]).ownerNameById).toEqual({})
    const messy = indexOwners([null as unknown as HubSpotOwner, { id: null }, { id: '7', teams: [null as never, { name: 'No id' }] }])
    expect(messy.ownerNameById).toEqual({ '7': 'Owner 7' })
    expect(messy.teamNameById).toEqual({})
  })
})

describe('ownerLabel and teamLabel', () => {
  const index = indexOwners(OWNERS)

  it('shows the name, or the id for an owner outside the page of owners fetched', () => {
    expect(ownerLabel(index, '82370091')).toBe('Jillian Rocco')
    expect(ownerLabel(index, '99999')).toBe('Owner 99999')
  })

  it('shows the app placeholder for a deal with no owner', () => {
    expect(ownerLabel(index, null)).toBe('—')
    expect(ownerLabel(index, '  ')).toBe('—')
  })

  it('uses the team on the deal when there is one', () => {
    expect(teamLabel(index, '949190')).toBe('Echo Barrier USA sales')
  })

  it("falls back to the OWNER's primary team for deals synced before HubSpot stamped one", () => {
    expect(teamLabel(index, null, '11111')).toBe('France team')
    expect(teamLabel(index, '', '82370091')).toBe('Echo Barrier USA sales')
  })

  it('shows the placeholder when neither the deal nor the owner resolves a team', () => {
    expect(teamLabel(index, null, '85301222')).toBe('—')
    expect(teamLabel(index, null, null)).toBe('—')
  })
})
