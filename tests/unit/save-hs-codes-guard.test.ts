import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The HS codes endpoint checks the caller before the service role writes.
 *
 * Every export of a 'use server' file is a public endpoint, and product_hs_codes
 * has no write policy, so the service-role client in save-hs-codes.ts is the
 * only thing between a request and the codes printed on every customs invoice.
 * This pins that shape at source level: one export, the capability check, the
 * zod parse, then the admin client, and no other file writing the table.
 */

const ACTION = 'src/app/actions/invoices/save-hs-codes.ts'
const PAGE = 'src/app/(dashboard)/invoices/hs-codes/page.tsx'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

describe('the HS codes guard finds its files', () => {
  it('has the action and the page where it expects them', () => {
    for (const rel of [ACTION, PAGE]) expect(existsSync(join(process.cwd(), rel)), rel).toBe(true)
  })
})

describe('src/app/actions/invoices/save-hs-codes.ts', () => {
  const source = existsSync(join(process.cwd(), ACTION)) ? read(ACTION) : ''
  const body = code(source)

  it('is a server actions file', () => {
    expect(source).toMatch(/^\s*['"]use server['"]/)
  })

  it('exports saveHsCodes and nothing else that runs', () => {
    const fns = [...body.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1])
    expect(fns).toEqual(['saveHsCodes'])
    const exportLines = body.split('\n').filter((line) => /^\s*export\b/.test(line))
    const other = exportLines.filter((line) => !/^export\s+(async\s+function|type|interface)\b/.test(line))
    expect(other).toEqual([])
    expect(body).not.toMatch(/\bexport\s*\{/)
    expect(body).not.toMatch(/\bexport\s+default\b/)
  })

  it('takes no user id from the caller', () => {
    const params = [...body.matchAll(/^export\s+async\s+function\s+\w+\s*\(([^)]*)\)/gm)].map((m) => m[1])
    expect(params).toHaveLength(1)
    expect(params[0]).not.toMatch(/user_?id|userId|uid/i)
    expect(body).not.toMatch(/user_?id|userId|uid/i)
  })

  it('checks the session, then invoice.create, then parses, then creates the admin client', () => {
    const session = body.indexOf('await getAuthorizedUser()')
    const denied = body.search(/if \(!auth\.ok\) return \{ ok: false/)
    const capability = body.search(/if \(!auth\.capabilities\.has\('invoice\.create'\)\) \{\s*return \{ ok: false/)
    const parse = body.indexOf('Schema.safeParse(input)')
    const parseFail = body.search(/if \(!parsed\.success\) return \{ ok: false/)
    const admin = body.indexOf('createAdminClient()')
    for (const [name, at] of Object.entries({ session, denied, capability, parse, parseFail, admin })) {
      expect(at, name).toBeGreaterThan(-1)
    }
    expect(session).toBeLessThan(denied)
    expect(denied).toBeLessThan(capability)
    expect(capability).toBeLessThan(parse)
    expect(parse).toBeLessThan(parseFail)
    expect(parseFail).toBeLessThan(admin)
    // One admin client, created once.
    expect(body.match(/createAdminClient\(\)/g) ?? []).toHaveLength(1)
  })

  it('writes only product_hs_codes, and only after the checks', () => {
    const admin = body.indexOf('createAdminClient()')
    const writes = [...body.matchAll(/\.(upsert|insert|update|delete)\(/g)]
    expect(writes.map((m) => m[1]).sort()).toEqual(['delete', 'upsert'])
    for (const w of writes) expect(w.index!).toBeGreaterThan(admin)
    const tables = [...body.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1])
    expect(new Set(tables)).toEqual(new Set(['intercompany_prices', 'po_product_catalog', 'product_hs_codes']))
    expect(body).toMatch(/\.from\('product_hs_codes'\)\.upsert\(upserts, \{ onConflict: 'sku,leg' \}\)/)
    expect(body).toMatch(/\.from\('product_hs_codes'\)\.delete\(\)\.eq\('sku', sku\)\.in\('leg', cleared\)/)
  })

  it('accepts a SKU that is priced OR in the active catalogue, and refuses anything else before any write', () => {
    // H1: a catalogue product with no transfer price still lands on invoices, so
    // it must be codeable. The page lists the same union.
    const priced = body.search(/\.from\('intercompany_prices'\)\.select\('sku'\)\.eq\('sku', sku\)/)
    const listed = body.search(/\.from\('po_product_catalog'\)\.select\('sku'\)\.eq\('sku', sku\)\.eq\('active', true\)/)
    const lookupFail = body.search(/if \(priceErr \|\| catalogErr\) return \{ ok: false/)
    const refuse = body.search(/if \(!priced\?\.length && !listed\?\.length\) \{\s*return \{ ok: false/)
    const firstWrite = body.search(/\.(upsert|delete)\(/)
    for (const [name, at] of Object.entries({ priced, listed, lookupFail, refuse })) expect(at, name).toBeGreaterThan(-1)
    expect(lookupFail).toBeGreaterThan(Math.max(priced, listed))
    expect(refuse).toBeGreaterThan(lookupFail)
    expect(firstWrite).toBeGreaterThan(refuse)
  })

  it('treats codes as a partial record: absent legs are never touched', () => {
    // H8: each leg is optional, and only the legs received are upserted or deleted.
    expect(body).toMatch(/codes: z\s*\.object\(codesShape\)\s*\.partial\(\)\s*\.strict\(\)/)
    expect(body).toMatch(/const received = INVOICE_LEGS\.filter\(\(leg\) => codes\[leg\] !== undefined\)/)
    expect(body).toMatch(/const upserts = received\s*\.filter/)
    expect(body).toMatch(/const cleared = received\.filter/)
    expect(body).not.toMatch(/INVOICE_LEGS\.filter\(\(leg\) => codes\[leg\] (===|!==) ''\)/)
  })

  it('normalises each code and validates it with the shared rule', () => {
    expect(body).toMatch(/\.transform\(normaliseHsCode\)/)
    expect(body).toMatch(/\.refine\(\(v\) => v === '' \|\| isValidHsCode\(v\)/)
    expect(body).toMatch(/import \{ isValidHsCode, normaliseHsCode \} from '@\/lib\/hs-codes'/)
  })

  it('revalidates the whole invoices layout', () => {
    expect(body).toContain("revalidatePath('/invoices', 'layout')")
  })
})

describe('the HS codes page', () => {
  const body = existsSync(join(process.cwd(), PAGE)) ? code(read(PAGE)) : ''

  it('checks invoice.view before it reads anything, and decides editing on invoice.create', () => {
    const gate = body.indexOf("await requireCapability('invoice.view')")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('createAdminClient()'))
    expect(gate).toBeLessThan(body.indexOf('createServerClient()'))
    expect(body).toMatch(/const canEdit = auth\.capabilities\.has\('invoice\.create'\)/)
  })

  it('reads which SKU is priced on which leg through the service role, never a value', () => {
    expect(body).toContain("admin.from('intercompany_prices').select('sku, leg, active')")
    expect(body).not.toMatch(/unit_value/)
    expect(body).not.toMatch(/\.(upsert|insert|update|delete)\(/)
  })

  it('lists the union of priced SKUs and active catalogue SKUs', () => {
    expect(body).toContain("supabase.from('po_product_catalog').select('sku, product_name, active')")
    expect(body).toMatch(/\.\.\.prices\.map\(\(r\) => r\.sku\), \.\.\.catalog\.filter\(\(r\) => r\.active\)\.map\(\(r\) => r\.sku\)/)
  })

  it('counts a leg only where the product has an active price on it', () => {
    expect(body).toMatch(/if \(!row\.active \|\| !isInvoiceLeg\(row\.leg\)\) continue/)
    expect(body).toMatch(/pricedLegs: INVOICE_LEGS\.filter/)
  })
})

describe('the HS codes screen', () => {
  const client = code(read('src/app/(dashboard)/invoices/hs-codes/hs-codes-client.tsx'))

  it('sends only the legs that changed, never the whole row', () => {
    // Sending every leg would blank a code a colleague saved on another leg.
    expect(client).toContain('Object.fromEntries(changed.map((s) => [s.leg, s.code]))')
    expect(client).not.toMatch(/Object\.fromEntries\(state\.map/)
  })

  it('drops a box typed back to the saved code, so it is not sent later', () => {
    expect(client).toMatch(/const same = value === baseline\(p, leg\)/)
    expect(client).toMatch(/if \(same\) delete row\[leg\]/)
  })

  it('leaves the stored draft alone while the product list failed to load', () => {
    expect(client).toContain('enabled: canEdit && !loadError')
    expect(client).toContain('load: canEdit && !loadError')
    expect(client).toMatch(/if \(!canEdit \|\| loadError\) return\s+saveDraft/)
  })
})

describe('product_hs_codes writes', () => {
  it('happen in save-hs-codes.ts and nowhere else in src', () => {
    const offenders = walk(join(process.cwd(), 'src'))
      .map((full) => full.replace(`${process.cwd()}/`, ''))
      .filter((rel) => rel !== ACTION)
      .filter((rel) => /from\(\s*['"]product_hs_codes['"]\s*\)\s*\.\s*(upsert|insert|update|delete)\(/.test(code(read(rel))))
    expect(offenders).toEqual([])
  })
})
