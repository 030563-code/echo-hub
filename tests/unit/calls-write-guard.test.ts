import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One door to the call table, and one door to the merge.
 *
 * `hub_calls` holds customer conversations and the record of who merged which
 * contact into which. It is closed to anon and authenticated in the database, so
 * every write is service-role, which means the only thing standing between a
 * future edit and an unguarded write is where that write is allowed to live.
 *
 * The merge matters more. `POST /crm/v3/objects/contacts/merge` permanently
 * fuses two HubSpot contacts, and HubSpot cannot undo it. It belongs in exactly
 * one file, behind a capability check, a placeholder check and a confirmation.
 *
 * Source-grep in the house style: stock-write-guard and email-recipients-guard.
 */

const SRC = join(process.cwd(), 'src')
const ACTIONS = 'src/app/(dashboard)/calls/actions.ts'
const INGEST = 'src/app/api/calls/ingest/route.ts'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(full) ? [full] : []
  })
}

const FILES = walk(SRC)
const rel = (f: string) => f.slice(process.cwd().length + 1)
const read = (f: string) => readFileSync(f, 'utf8')

describe('the guard can see the files it is guarding', () => {
  it('finds a decent number of source files, and both doors', () => {
    expect(FILES.length).toBeGreaterThan(100)
    expect(FILES.map(rel)).toContain(ACTIONS)
    expect(FILES.map(rel)).toContain(INGEST)
  })
})

describe('writes to hub_calls', () => {
  it('happen in the calls actions and the ingest route, and nowhere else', () => {
    const writers = FILES.filter((file) => {
      const source = read(file)
      // A write is an .update()/.insert()/.upsert()/.delete() on the table, or
      // the ingest RPC that does the insert on our behalf.
      const touchesTable = /from\(['"]hub_calls['"]\)[\s\S]{0,400}?\.(update|insert|upsert|delete)\(/.test(source)
      const callsRpc = source.includes('hub_ingest_phone_call')
      return touchesTable || callsRpc
    }).map(rel)

    expect(writers.sort()).toEqual([ACTIONS, INGEST].sort())
  })
})

describe('the HubSpot contact merge', () => {
  const mergers = FILES.filter((file) => read(file).includes('/contacts/merge')).map(rel)

  it('is called from one file only', () => {
    expect(mergers).toEqual([ACTIONS])
  })

  it('goes through hubspotFetch, so staging cannot reach the live portal', () => {
    const source = read(join(process.cwd(), ACTIONS))
    // Every merge call site is a hubspotFetch call site.
    const mergeCalls = source.match(/hubspotFetch\('https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/merge'/g) ?? []
    expect(mergeCalls.length).toBe(2) // from a call, and from the placeholder list
    expect(source).not.toMatch(/fetch\('https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/merge/)
  })

  it('never runs before the caller is checked, the record is proven a placeholder, and the blast radius is known', () => {
    const source = read(join(process.cwd(), ACTIONS))
    const firstMerge = source.indexOf('/contacts/merge')
    for (const required of ['getAuthorizedUser()', 'isPlaceholderContact', 'countAssociations', 'confirmExtra']) {
      const at = source.indexOf(required)
      expect(at, `${required} must appear before the first merge`).toBeGreaterThan(-1)
      expect(at).toBeLessThan(firstMerge)
    }
  })

  it('refuses to merge a record that is not a placeholder', () => {
    const source = read(join(process.cwd(), ACTIONS))
    expect(source).toMatch(/if \(!isPlaceholderContact\(placeholder\.contact\)\)/)
  })
})

describe('after the merge', () => {
  const source = read(join(process.cwd(), ACTIONS))

  it('keeps the id HubSpot returns, not the one the rep clicked, in both link paths', () => {
    expect(source.match(/mergedId = await mergedObjectId\(response, contactId\)/g)?.length).toBe(2)
    expect(source.match(/linked_contact_id: mergedId/g)?.length).toBe(3)
    expect(source).not.toMatch(/linked_contact_id: contactId/)
    expect(source.match(/mergedInto: mergedId/g)?.length).toBe(2)
  })

  it('gives the moved calls the company and deals HubSpot would have, reading the calls BEFORE the merge', () => {
    expect(source.match(/associateLikeHubSpot\(mergedId, callIds\)/g)?.length).toBe(2)
    const firstRead = source.indexOf('callIdsOnContact(')
    expect(firstRead).toBeGreaterThan(-1)
    expect(firstRead).toBeLessThan(source.indexOf('/contacts/merge'))
  })
})

describe('the missed-call gate', () => {
  it('stops a missed call being linked before somebody says why', () => {
    const source = read(join(process.cwd(), ACTIONS))
    expect(source).toMatch(/isMissedCall\(call\) && !call\.missed_reason/)
    // And it sits before the merge, not after it.
    expect(source.indexOf('isMissedCall(call) && !call.missed_reason')).toBeLessThan(source.indexOf('/contacts/merge'))
  })
})

describe('the ingest route', () => {
  const source = read(join(process.cwd(), INGEST))

  it('checks the bearer secret before it does anything else', () => {
    expect(source).toContain('bearerAuthorized(request.headers.get')
    expect(source.indexOf('bearerAuthorized')).toBeLessThan(source.indexOf('request.text()'))
  })

  it('parses with zod and never spreads the raw body into the write', () => {
    expect(source).toContain('callPayloadSchema.safeParse(body)')
    expect(source).not.toMatch(/\.\.\.body/)
  })

  it('is listed in the middleware allowlist, or every call is redirected to the login page', () => {
    const mw = read(join(process.cwd(), 'src/middleware.ts'))
    expect(mw).toContain("'/api/calls/ingest'")
  })
})
