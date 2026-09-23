import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCargoPayload, cargoStatus, cargoTimeline } from '@/lib/cargo/payload'
import { isPhysicalMilestone } from '@/lib/cargo/event-types'

/**
 * What a customer is allowed to see, and what the door to it looks like.
 *
 * Dean, 22 Sep 2026: a cargo view "which can be shared internally with the team
 * and, where appropriate, with clients." The internal page carries the goods
 * value, the declared weight, the bills of lading and both companies' legal
 * names. A link sent to a customer must carry none of that, and the only thing
 * standing between the open internet and this page is the token in its URL.
 *
 * These are file-level pins as well as behaviour ones on purpose: the leak this
 * guards against is a field ADDED later, which no behavioural test written today
 * would notice.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')
const fixture = (id: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/cargo', `${id}.json`), 'utf8'))

const TODAY = '2026-09-22'
const SAILING = '244498887'

describe('the customer view is a whitelist, not a delete list', () => {
  it('names every field it will show, and nothing commercial is among them', () => {
    const source = read('src/lib/cargo/store.ts')
    const block = source.slice(source.indexOf('export interface CargoPublicView'))
    const fields = [...block.slice(0, block.indexOf('}')).matchAll(/^\s{2}(\w+)[?:]/gm)].map((m) => m[1])

    expect(fields).toEqual([
      'reference',
      'containerNumbers',
      'vesselName',
      'oceanCarrier',
      'originCity',
      'destinationCity',
      'cargoDescription',
      'eta',
      'currentStatus',
      'currentStatusOn',
      'currentStatusLocation',
      'isComplete',
      'timeline',
      'syncedAt',
    ])

    // 🔴 Each of these is on the internal view and must never join the list
    // above without somebody deciding it should. Add a field to CargoPublicView
    // and this test fails until the decision is made out loud.
    for (const banned of [
      'goodsValue',
      'currencyCode',
      'totalWeight',
      'totalVolume',
      'shipperName',
      'consigneeName',
      'hbl',
      'mbl',
      'spotId',
      'destinationDepot',
      'slipDays',
      'events',
      'route',
      // Our own references and the shipping sheet's order numbers (23 Sep 2026).
      'references',
      'ownReferences',
      'sheetReferences',
    ]) {
      expect(fields, `${banned} must not be on the customer's page`).not.toContain(banned)
    }
  })

  it('the tracking page renders no field the whitelist does not carry', () => {
    // It reads `view.<field>` and nothing else off the shipment.
    const page = read('src/app/track/[token]/page.tsx')
    const used = new Set([...page.matchAll(/\bview\.(\w+)/g)].map((m) => m[1]))
    const allowed = new Set([
      'reference',
      'containerNumbers',
      'vesselName',
      'oceanCarrier',
      'originCity',
      'destinationCity',
      'cargoDescription',
      'eta',
      'currentStatus',
      'currentStatusOn',
      'currentStatusLocation',
      'isComplete',
      'timeline',
      'syncedAt',
    ])
    for (const field of used) expect(allowed.has(field), `view.${field} is not on the whitelist`).toBe(true)
  })

  it('never loads the shipment with a session client, because the tables refuse one', () => {
    const page = read('src/app/track/[token]/page.tsx')
    expect(page).toContain('createAdminClient')
    expect(page).not.toContain('createServerClient')
  })
})

describe('the door the customer comes through', () => {
  it('is exempt from the session gate, and says why', () => {
    const mw = read('src/middleware.ts')
    const list = mw.match(/const PUBLIC_PATHS = \[([^\]]*)\]/)
    const paths = [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(paths).toContain('/track')
    expect(mw).toContain('32 random bytes')
  })

  it('mints a token nobody can guess, and refuses a short one at the database', () => {
    const action = read('src/app/actions/cargo/share-link.ts')
    // 32 bytes, not a hash of the SPOT ID and not a counter.
    expect(action).toContain('randomBytes(32)')
    expect(action).not.toMatch(/token:\s*spotId/)
    const migration = read('supabase/migrations/20260922130000_cargo_share_links.sql')
    expect(migration).toContain('check (length(token) >= 32)')
  })

  it('refuses a revoked link, an expired one and an invented one the same way', () => {
    const page = read('src/app/track/[token]/page.tsx')
    // One message, one component, three routes into it.
    expect(page).toContain('if (link.revoked_at) return null')
    expect(page).toContain('Date.parse(link.expires_at) < Date.now()')
    expect((page.match(/This tracking link is not available/g) ?? []).length).toBe(1)
  })

  it('checks the caller holds the shipment before minting or revoking a link', () => {
    const action = read('src/app/actions/cargo/share-link.ts')
    // Both writes, and the read that lists them, go through the same check.
    expect((action.match(/await shipmentInScope\(/g) ?? []).length).toBe(3)
    expect((action.match(/await transportScope\(\)/g) ?? []).length).toBe(3)
    // The capability check lives with the scope, shared with the other Transport actions.
    expect(action).toContain("from '@/lib/cargo/scope.server'")
    expect(read('src/lib/cargo/scope.server.ts')).toContain("auth.capabilities.has('transport.view')")
  })

  it('keeps our note about the recipient off their page', () => {
    const migration = read('supabase/migrations/20260922130000_cargo_share_links.sql')
    expect(migration).toContain('Never rendered on the shared page')
    const page = read('src/app/track/[token]/page.tsx')
    // The word appears in the comment explaining why it is absent, so assert on
    // the two things that would actually put it on screen: selecting the column,
    // and reading the field.
    const select = page.match(/\.select\('([^']*)'\)/)?.[1] ?? ''
    expect(select).not.toContain('label')
    expect(page).not.toMatch(/\b(view|link|shipment)\.label\b/)
  })
})

describe('a customer is told where the container is, not what happened in an office', () => {
  it('skips the paperwork milestones', () => {
    expect(isPhysicalMilestone('21')).toBe(false) // Pre-alert processed
    expect(isPhysicalMilestone('50')).toBe(false) // Booking confirmed
    expect(isPhysicalMilestone('51')).toBe(false) // Booking requested
    expect(isPhysicalMilestone('95')).toBe(false) // Approved by decision maker
    expect(isPhysicalMilestone('20')).toBe(false) // Handling finished
    expect(isPhysicalMilestone('7')).toBe(true) // Departed
    expect(isPhysicalMilestone('90')).toBe(true) // Loaded on vessel
    expect(isPhysicalMilestone('24')).toBe(true) // Export customs cleared
  })

  it('shows the container moving where the internal page shows the paperwork', () => {
    const { events } = parseCargoPayload(fixture(SAILING), SAILING)
    const internal = cargoStatus(events, TODAY)
    const customer = cargoStatus(events, TODAY, { physicalOnly: true })
    expect(internal?.name).toBe('Pre-alert processed')
    expect(customer?.name).toBe('Departed')
    expect(customer?.location).toBe('Bremerhaven')
  })

  it('never shows the customer an older position than we have', () => {
    // The filter may only ever skip PAST events, never a later one.
    for (const id of ['244498887', '245446323', '245490305', '243291911']) {
      const { events } = parseCargoPayload(fixture(id), id)
      const internal = cargoStatus(events, TODAY)
      const customer = cargoStatus(events, TODAY, { physicalOnly: true })
      if (!customer || !internal) continue
      expect(customer.date <= internal.date, id).toBe(true)
    }
  })

  it('shows the same route we see, because the route is not a secret', () => {
    const p = parseCargoPayload(fixture(SAILING), SAILING)
    const stops = cargoTimeline(p.route, p.events, TODAY)
    expect(stops.length).toBeGreaterThan(2)
    // And no stop carries anything commercial.
    for (const s of stops) {
      expect(Object.keys(s).sort()).toEqual(
        ['actual', 'caption', 'code', 'countryCode', 'date', 'label', 'legToNext', 'place', 'state', 'type'].sort(),
      )
    }
  })
})
