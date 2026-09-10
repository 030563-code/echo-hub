import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * getOwnerIndex must read BOTH owner registers.
 *
 * HubSpot's owners endpoint returns only active seats unless asked for the
 * archived ones, and in this portal the departed reps hold most of the CRM:
 * measured live on 9 Sep 2026, 5,796 of 9,500 companies belong to archived
 * owners, two of them holding 3,790 and 2,006. With only the active register
 * indexed, every one of those records printed "Owner 30350649" where a name
 * belongs, on the deals board and now in the company picker.
 *
 * indexOwners has always KEPT archived entries (see hubspot-owners.test.ts);
 * nothing had ever fetched them. This reads the action's source rather than its
 * behaviour because the fetch is the whole point and mocking it would prove the
 * mock. Same genre as page-state-guard and email-recipients-guard.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/actions/hubspot/getOwners.ts'),
  'utf8',
)

describe('getOwnerIndex source', () => {
  it('self-check: the file was found and is the owners action', () => {
    // A moved or renamed file must fail loudly rather than pass vacuously.
    expect(SOURCE.length).toBeGreaterThan(500)
    expect(SOURCE).toContain('export async function getOwnerIndex')
  })

  it('asks for the archived register as well as the active one', () => {
    expect(SOURCE).toContain('archived=true')
  })

  it('indexes the two registers together', () => {
    // Indexing them separately and keeping one would silently drop the other.
    expect(SOURCE).toMatch(/indexOwners\(\[\s*\.\.\.active\s*,\s*\.\.\.\(?archived/)
  })

  it('degrades rather than discarding a good active fetch', () => {
    // Names on old records are worth less than the deals board working, so a
    // failed archived call must not throw away the active register.
    expect(SOURCE).toMatch(/if \(!active\) return/)
  })

  it('lets a pricing admin resolve owner names', () => {
    // The contractor editor's company search shows the owner, so pricing.manage
    // reaches this too. Without it that page prints a raw id.
    expect(SOURCE).toMatch(/hasAnyCapability\(\[[^\]]*'pricing\.manage'/)
  })
})

describe('searchCompanies source', () => {
  const SEARCH = readFileSync(
    join(process.cwd(), 'src/app/actions/hubspot/searchCompanies.ts'),
    'utf8',
  )

  it('self-check: the file was found and is the company search', () => {
    expect(SEARCH.length).toBeGreaterThan(500)
    expect(SEARCH).toContain('export async function searchCompanies')
  })

  it('never pins hubspot_owner_id: the scope is the TEAM, not the person', () => {
    // Dean, 9 Sep 2026: a rep must find a company a colleague brought in.
    // Dimeo Construction sits under a rep who has left, so owner scoping
    // cannot reach it by any route. Measured live: owner scoping gave that rep
    // 426 of 57,400 companies; team scoping gives 27,994.
    expect(SEARCH).not.toContain("propertyName: 'hubspot_owner_id'")
  })

  it('scopes on hs_all_team_ids, the stamp that survives the owner leaving', () => {
    // hubspot_team_id on the OWNER is wiped when a seat is archived (Dimeo's
    // owner carries no teams at all), but the stamp on the COMPANY persists.
    // That is the whole reason this property is the one being filtered.
    expect(SEARCH).toContain("propertyName: 'hs_all_team_ids'")
    expect(SEARCH).toContain('teamsForPipeline(')
  })

  it('fails closed when the caller has no region', () => {
    // An unscoped search for a rep with no pipeline would hand them all 57,400
    // companies, which is the thing the scoping exists to stop.
    expect(SEARCH).toMatch(/teamScope\.length === 0[\s\S]{0,400}success: false/)
  })

  it('returns the owner so same-named duplicates stay tellable apart', () => {
    // The owner label is what replaced the filter as the guard against
    // attaching a deal to the wrong region's account.
    expect(SEARCH).toContain('ownerLabel(')
  })
})
