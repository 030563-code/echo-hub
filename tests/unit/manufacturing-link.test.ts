import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hashToken, linkLifetimeDays } from '@/lib/manufacturing-token'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

/** Comments explain the rule; only the CODE can break it. */
const readCode = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const TOKEN_LIB = 'src/lib/manufacturing-token.ts'
const ACTIONS = 'src/app/actions/manufacturing/supplier-updates.ts'
const PAGE = 'src/app/manufacturing/[token]/page.tsx'
const MIGRATION = 'supabase/migrations/20260908140000_manufacturing_access_tokens.sql'

const ORIGINAL = process.env.MANUFACTURING_LINK_DAYS
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MANUFACTURING_LINK_DAYS
  else process.env.MANUFACTURING_LINK_DAYS = ORIGINAL
})

describe('the raw token never reaches the database', () => {
  it('stores a sha256, which is what the table constrains to 64 characters', () => {
    const raw = 'a-token-that-was-emailed'
    expect(hashToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(hashToken(raw)).toHaveLength(64)
    expect(read(MIGRATION)).toContain('length(token_hash) = 64')
  })

  it('inserts the hash, never the token itself', () => {
    const source = read(TOKEN_LIB)
    expect(source).toContain('token_hash: hashToken(raw)')
    expect(source).not.toMatch(/token:\s*raw/)
  })

  it('puts the raw token only in the returned url', () => {
    expect(read(TOKEN_LIB)).toContain('/manufacturing/${raw}')
  })
})

describe('the link is reusable, because Bamida come back to it', () => {
  it('records last use and never gates on it', () => {
    const source = read(TOKEN_LIB)
    expect(source).toContain('last_used_at')
    // A single-use token would lock them out between giving their dates and
    // pressing finished, which puts Juraj back in the middle.
    expect(source).not.toMatch(/last_used_at[^\n]*is not null[\s\S]{0,120}reason/)
    expect(source).toMatch(/revoked_at !== null[\s\S]{0,60}reason: 'revoked'/)
    expect(source).toMatch(/expires_at[\s\S]{0,80}reason: 'expired'/)
  })

  it('is generous by default and configurable', () => {
    delete process.env.MANUFACTURING_LINK_DAYS
    expect(linkLifetimeDays()).toBe(180)
    process.env.MANUFACTURING_LINK_DAYS = '30'
    expect(linkLifetimeDays()).toBe(30)
  })

  it('ignores a nonsense lifetime rather than minting an already-dead link', () => {
    process.env.MANUFACTURING_LINK_DAYS = 'soon'
    expect(linkLifetimeDays()).toBe(180)
    process.env.MANUFACTURING_LINK_DAYS = '0'
    expect(linkLifetimeDays()).toBe(180)
    process.env.MANUFACTURING_LINK_DAYS = '-5'
    expect(linkLifetimeDays()).toBe(180)
  })

  it('leaves exactly one live link per order, so a resend is unambiguous', () => {
    expect(read(TOKEN_LIB)).toMatch(/update\(\{ revoked_at: nowIso \}\)[\s\S]{0,120}\.is\('revoked_at', null\)/)
  })
})

describe('Bamida can never see a price', () => {
  it('excludes cost at the QUERY, not at the render', () => {
    const source = readCode(PAGE)
    // The select names three columns. Cost is not omitted from the markup, it
    // never enters the process, so no future edit to the page can leak it.
    expect(source).toContain('purchase_order_lines(sku, product_name, quantity)')
    for (const forbidden of ['unit_price', 'cost_snapshot', 'sro_cost_snapshot_eur', 'cost.view']) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('lives outside the dashboard, so there is no Hub navigation to follow', () => {
    expect(PAGE.startsWith('src/app/manufacturing/')).toBe(true)
    expect(readCode(PAGE)).not.toContain('(dashboard)')
  })
})

describe("the supplier actions trust the token and nothing the caller sends", () => {
  const source = read(ACTIONS)

  it('resolves the token on every exported action', () => {
    const actions = source.match(/export async function (\w+)/g) ?? []
    expect(actions.length).toBe(2)
    expect((source.match(/resolveManufacturingToken\(/g) ?? []).length).toBe(actions.length)
  })

  it('never accepts a purchase order id from the caller', () => {
    // One valid link would otherwise be a licence to write to any order.
    expect(source).not.toMatch(/po_?[Ii]d:\s*z\./)
    expect(source).toContain('resolved.poId')
  })

  it('makes finished a one-shot conditional update', () => {
    expect(source).toMatch(
      /update\(\{ finished_at: new Date\(\)\.toISOString\(\) \}\)[\s\S]{0,160}\.is\('finished_at', null\)/,
    )
    expect(source).toContain('already marked finished')
  })

  it('stops the dates changing once the order is finished', () => {
    expect(source).toMatch(/est_start[\s\S]{0,300}\.is\('finished_at', null\)/)
  })

  it('refuses a finish date before the start date', () => {
    expect(source).toContain('cannot be before the start date')
  })
})

describe('the supplier route is reachable without a session', () => {
  it('is public in the middleware, with the reason written down', () => {
    const source = read('src/middleware.ts')
    expect(source).toMatch(/PUBLIC_PATHS = \[[^\]]*'\/manufacturing'/)
    expect(source).toContain('The token IS the authorisation')
  })
})

describe('the token table is not reachable from a browser', () => {
  it('turns RLS on and revokes every grant', () => {
    const sql = read(MIGRATION)
    expect(sql).toContain('enable row level security')
    expect(sql).toMatch(/revoke all on public\.manufacturing_access_tokens from public, anon, authenticated/)
  })
})

describe('the email carries the link', () => {
  it('mints it after the claim and refuses to send without one', () => {
    const source = read('src/app/actions/purchase-orders/send-manufacturing-po.ts')
    expect(source.indexOf(".is(\"sent_at\", null)")).toBeLessThan(source.indexOf('mintManufacturingLink('))
    expect(source).toMatch(/if \(!link\)[\s\S]{0,240}sent_at: null[\s\S]{0,160}ok: false/)
    expect(source).toContain('link: link.url')
  })
})
