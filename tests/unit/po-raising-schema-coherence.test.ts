import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  RAISING_PARTIES,
  RAISABLE_PARTIES,
  XERO_CODE_COLUMNS,
  canRaiseFor,
  catalogueFor,
  indexCodes,
  raisingBlockedReason,
  raisingParty,
  xeroItemCode,
  type ProductXeroCodes,
} from '@/lib/po-raising'
import { PO_PREFIX_BY_DEPOT, isNewSchemePoNumber } from '@/lib/po-number'

/**
 * Who may raise a purchase order, in one table, and the migration that agrees
 * with it.
 *
 * 🔴 THE FAULT THIS EXISTS TO PREVENT. The same facts were written out four
 * times: V1_DEPOTS on the create page, DEPOT_CODE_COL in the form,
 * PO_PREFIX_BY_DEPOT here, and a `let codeCol = "code_usa_balt"` with three ifs
 * inside n8n Fz7xXgifva5n548u. The fourth one is the one Xero actually obeys,
 * and it DEFAULTED, so a French order (EU-FR already had a number series) would
 * have been created in the United States Xero organisation carrying US
 * Baltimore item codes, with nothing said anywhere.
 */

const MIG = 'supabase/migrations/20260921140000_po_raising_parties.sql'
const DOWN = 'supabase/migrations/rollback/20260921140000_po_raising_parties.down.sql'

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
  const bodyOpen = sql.indexOf('$$', start)
  const bodyClose = sql.indexOf('$$;', bodyOpen + 2)
  expect(bodyClose, `${name} body not closed`).toBeGreaterThan(bodyOpen)
  return sql.slice(start, bodyClose + 3)
}

const raw = readFileSync(join(process.cwd(), MIG), 'utf8')
const up = stripComments(raw)

// A product_code_master shaped fixture, taken from the live table on 21 Sep 2026.
const CODES: Partial<ProductXeroCodes>[] = [
  { internal_sku: 'EBH9', code_usa_balt: 'H9BALT', code_usa_sb: 'H9SB', code_canada: 'H9HAM', code_france: 'H9', code_uk: '01-EBH9', code_grp: '01-EBH9', code_sro: 'SK-EBH9' },
  { internal_sku: 'EBH9X', code_usa_balt: 'H9XBALT', code_usa_sb: 'H9XSB', code_canada: null, code_france: null, code_uk: '01-H9X', code_grp: '01-EBH9X', code_sro: 'SK-EBH9X' },
  // The live V2 row really does carry trailing spaces on its Baltimore code.
  { internal_sku: 'V2', code_usa_balt: 'V2BALT  ', code_usa_sb: null, code_canada: 'V2HAM', code_france: 'V2', code_uk: '01-V2A', code_grp: null, code_sro: 'SK-EBV2' },
  { internal_sku: 'VFK', code_usa_balt: 'VFKB', code_usa_sb: null, code_canada: null, code_france: null, code_uk: null, code_grp: null, code_sro: 'SK-VFK' },
]
const CATALOGUE = [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', internal_sku: 'EBH9' },
  { sku: 'EBH9XNA', product_name: 'Echo Barrier H9X', product_family: 'H9', internal_sku: 'EBH9X' },
  { sku: 'V2NA', product_name: 'Echo Barrier V2', product_family: 'V2', internal_sku: 'V2' },
  { sku: 'EBVFKNA', product_name: 'Vertical Fitting Kits', product_family: 'ACC', internal_sku: 'VFK' },
  { sku: 'ORPHAN', product_name: 'No master row', product_family: 'ACC', internal_sku: null },
]
const byInternal = indexCodes(CODES)
const skusFor = (code: string) =>
  catalogueFor(raisingParty(code)!, CATALOGUE, byInternal).map((r) => r.item.sku)

describe('the raising registry', () => {
  it('carries the four parties Dean asked for, on their own legs', () => {
    expect(raisingParty('EU-FR')).toMatchObject({ leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-FRANCE', codeColumn: 'code_france', series: 'EBFRA' })
    expect(raisingParty('GB-BSE')).toMatchObject({ leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-UK', codeColumn: 'code_uk', series: 'EBUK' })
    // Group and s.r.o. are not depots and do not raise the depot leg.
    expect(raisingParty('EB-GROUP')).toMatchObject({ leg: 'EB_GROUP_TO_SRO', to: 'EB-SRO', org: 'EB-GROUP', codeColumn: 'code_grp', series: 'EBGRP' })
    expect(raisingParty('EB-SRO')).toMatchObject({ leg: 'SRO_TO_SUPPLIER', to: 'SUPPLIER', org: 'EB-SRO', codeColumn: 'code_sro', series: 'EBSRO' })
  })

  it('never defaults: an unmapped party refuses and says who can', () => {
    expect(raisingParty('EU-SK')).toBeNull()
    expect(canRaiseFor('EU-SK')).toBe(false)
    expect(raisingBlockedReason('EU-SK')).toContain('cannot raise purchase orders')
    expect(raisingBlockedReason('EU-SK')).toContain('EU-FR')
    expect(raisingBlockedReason(null)).toContain('(blank)')
    expect(raisingBlockedReason('')).toContain('(blank)')
  })

  it('refuses Australia with its reason rather than hiding it', () => {
    // It has a series and a Xero organisation and no item codes at all, which
    // is a fact about product_code_master, not an oversight here.
    expect(raisingParty('AU-SYD')?.codeColumn).toBeNull()
    expect(canRaiseFor('AU-SYD')).toBe(false)
    expect(raisingBlockedReason('AU-SYD')).toContain('no Xero product codes')
    expect(RAISABLE_PARTIES.map((p) => p.code)).not.toContain('AU-SYD')
  })

  it('is case and whitespace tolerant on the way in', () => {
    expect(raisingParty(' eu-fr ')?.code).toBe('EU-FR')
  })

  it('selects every code column it names, and no more', () => {
    const used = new Set(RAISING_PARTIES.map((p) => p.codeColumn).filter(Boolean))
    for (const col of used) expect(XERO_CODE_COLUMNS).toContain(col)
    expect(new Set(XERO_CODE_COLUMNS).size).toBe(XERO_CODE_COLUMNS.length)
  })

  it('gives every party a distinct code and a series', () => {
    const codes = RAISING_PARTIES.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const p of RAISING_PARTIES) expect(p.series, p.code).toMatch(/^EB[A-Z]+$/)
  })
})

describe('the depot-specific line items', () => {
  it('offers only the products this party has a Xero item code for', () => {
    // Dean, 21 Sep 2026: "The line items have to be loaded depot specific."
    expect(skusFor('US-BAL')).toEqual(['EBH9NA', 'EBH9XNA', 'V2NA', 'EBVFKNA'])
    expect(skusFor('US-SBD')).toEqual(['EBH9NA', 'EBH9XNA'])
    expect(skusFor('CA-HAM')).toEqual(['EBH9NA', 'V2NA'])
    expect(skusFor('EU-FR')).toEqual(['EBH9NA', 'V2NA'])
    expect(skusFor('GB-BSE')).toEqual(['EBH9NA', 'EBH9XNA', 'V2NA'])
    expect(skusFor('EB-GROUP')).toEqual(['EBH9NA', 'EBH9XNA'])
    expect(skusFor('EB-SRO')).toEqual(['EBH9NA', 'EBH9XNA', 'V2NA', 'EBVFKNA'])
  })

  it('never offers a product with no master row at all', () => {
    for (const p of RAISABLE_PARTIES) expect(skusFor(p.code)).not.toContain('ORPHAN')
  })

  it('returns the code the order will carry, and trims it', () => {
    // A Xero ItemCode with a trailing space does not match the item, and the
    // live V2 Baltimore code has two.
    const rows = catalogueFor(raisingParty('US-BAL')!, CATALOGUE, byInternal)
    expect(rows.find((r) => r.item.sku === 'V2NA')?.xeroItemCode).toBe('V2BALT')
    expect(xeroItemCode(raisingParty('GB-BSE')!, byInternal.get('EBH9'))).toBe('01-EBH9')
  })

  it('treats a blank or missing code as no code', () => {
    expect(xeroItemCode(raisingParty('EU-FR')!, { code_france: '   ' })).toBeNull()
    expect(xeroItemCode(raisingParty('EU-FR')!, undefined)).toBeNull()
    expect(xeroItemCode(raisingParty('AU-SYD')!, byInternal.get('EBH9'))).toBeNull()
  })

  it('gives France and the UK the codes that were in the table all along', () => {
    // Nothing selected code_france or code_uk before 21 Sep 2026. The create
    // page asked for five columns and there were seven.
    expect(skusFor('EU-FR').length).toBeGreaterThan(0)
    expect(skusFor('GB-BSE').length).toBeGreaterThan(0)
  })
})

describe('the raising migration', () => {
  it('carries the house header, records how it was applied, and has no em-dash', () => {
    expect(raw).toContain('Never db push.')
    // Dry-run inside begin/rollback before the real apply, and the header says
    // so: the next person should know that route exists.
    expect(raw).toContain('dry-run on korylyniwsqtsvzuzydg inside')
    expect(raw).toContain('applied live via MCP apply_migration')
    expect(raw).not.toContain('—')
  })

  it('names the n8n workflow that has to change with it', () => {
    // Publishing one without the other moves the fault rather than fixing it.
    expect(raw).toContain('Fz7xXgifva5n548u')
  })

  it('creates both new series at 8001 and closes them', () => {
    const created = [...up.matchAll(/create sequence (public\.po_number_seq_\w+) as bigint start with (\d+) minvalue (\d+) no cycle;/g)]
    expect(created.map((m) => m[1]).sort()).toEqual(['public.po_number_seq_ebsro', 'public.po_number_seq_ebuk'])
    for (const m of created) {
      expect(m[2]).toBe('8001')
      expect(m[3]).toBe('8001')
    }
    expect(up).toMatch(/revoke all on sequence public\.po_number_seq_ebuk, public\.po_number_seq_ebsro from public, anon, authenticated;/)
    expect(up).not.toMatch(/\bgrant\b/i)
  })

  it('winds the s.r.o. series past the numbers the DERIVED scheme already used', () => {
    // EBSRO<n>-1 has been minted from Group order digits since 14 Sep. The
    // standalone series shares that shape, so starting it at 8001 blind would
    // re-issue a number that is already a purchase order number in Xero.
    expect(up).toContain("max(substring(po_number from '^EBSRO([0-9]+)-[123]$')::bigint) + 1")
    expect(up).toContain("where po_number ~ '^EBSRO[0-9]+-[123]$'")
    expect(up.indexOf('create sequence public.po_number_seq_ebsro')).toBeLessThan(up.indexOf("setval('public.po_number_seq_ebsro'"))
  })

  it('maps exactly the depots the TypeScript maps, to the same series', () => {
    const body = fn(up, 'hub_po_prefix_for_depot')
    const pairs = Object.fromEntries([...body.matchAll(/when '([^']+)' then '([A-Z]+)'/g)].map((m) => [m[1], m[2]]))
    expect(pairs).toEqual({ ...PO_PREFIX_BY_DEPOT })
    expect(pairs).toEqual({
      'US-BAL': 'EBUSA', 'US-SBD': 'EBUSA', 'CA-HAM': 'EBCAN',
      'EU-FR': 'EBFRA', 'GB-BSE': 'EBUK', 'AU-SYD': 'EBAUS',
    })
  })

  it('still refuses an unmapped depot rather than falling back', () => {
    const body = fn(up, 'hub_po_prefix_for_depot')
    expect(body).not.toMatch(/\belse\b/)
    expect(body).toMatch(/if v_prefix is null then\s+raise exception 'Depot % has no purchase order number series\./)
    expect(body).toContain('GB-BSE')
    expect(up).toMatch(/revoke all on function public\.hub_po_prefix_for_depot\(text\) from public, anon, authenticated;/)
  })

  it('mints EBUK from its own sequence', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/v_prefix = 'EBUK' then\s+return v_prefix \|\| nextval\('public\.po_number_seq_ebuk'\);/)
    for (const prefix of ['EBUSA', 'EBCAN', 'EBFRA', 'EBAUS']) {
      expect(mint, prefix).toMatch(
        new RegExp(`v_prefix = '${prefix}' then\\s+return v_prefix \\|\\| nextval\\('public\\.po_number_seq_${prefix.toLowerCase()}'\\);`),
      )
    }
  })

  it('numbers a parentless s.r.o. manufacturing order, and still refuses a parentless shipping one', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(
      /if p_leg = 'SRO_TO_SUPPLIER' then\s+return 'EBSRO' \|\| nextval\('public\.po_number_seq_ebsro'\) \|\| '-1';/,
    )
    // A shipping order with nothing to ship stays a mistake.
    expect(mint).toMatch(/raise exception 'A % order takes its number from its SRO order, and this one has no parent_po_id\.', p_leg;/)
    // And the derived path is untouched.
    expect(mint).toContain("v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');")
    expect(mint).toMatch(/if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then/)
  })

  it('adds EBUK to the rename guard, and the guard still matches the TypeScript', () => {
    const guard = fn(up, 'po_guard_number_update')
    const num = guard.match(/and old\.po_number ~ '([^']+)' then/)?.[1] ?? ''
    const ref = guard.match(/and old\.master_ref ~ '([^']+)' then/)?.[1] ?? ''
    expect(num).toBe('^(EB(USA|CAN|FRA|UK|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$')
    expect(ref).toBe('^MR-(EB(USA|CAN|FRA|UK|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$')
    const numberPattern = new RegExp(num)
    const refPattern = new RegExp(ref)
    const samples = [
      'EBUK8001', 'EBUSA8001', 'EBCAN8001', 'EBFRA8001', 'EBAUS8001', 'EBGRP8001',
      'EBSRO8001-1', 'EBSRO8001-2', 'EBSRO8001-3', 'EBSRO8001-4', 'EBSRO8001',
      'EBUK', 'EBUKx8001', 'EBG26094', 'PO-01224', '1405', 'xEBUK8001', '',
    ]
    for (const n of samples) {
      expect(numberPattern.test(n), n).toBe(isNewSchemePoNumber(n))
      expect(refPattern.test(`MR-${n}`), `MR-${n}`).toBe(isNewSchemePoNumber(n))
    }
    expect(isNewSchemePoNumber('EBUK8001')).toBe(true)
  })

  it('adds the UK delivery address Dean gave, and placeholders for the rest', () => {
    expect(up).toContain("('GB-BSE', 'UK depot, Bury St Edmunds'")
    expect(up).toContain('118A Newmarket Rd, Bury Saint Edmunds IP33 3TF, United Kingdom')
    // A delivery address is printed on the order the manufacturer packs to, so
    // an invented one is worse than a visible gap.
    expect(up).toContain("('EU-FR', 'France depot', '- confirm ship-to address -')")
    expect(up).toContain("('AU-SYD', 'Australia depot, Sydney', '- confirm ship-to address -')")
  })

  it('can be applied twice without duplicating an address', () => {
    // 🔴 po_delivery_addresses has ONE unique index and it is the primary key on
    // id, so `on conflict do nothing` could never fire and a second apply would
    // give every depot a duplicate row in the dropdown. Checked against the
    // live table on 21 Sep 2026, not assumed.
    expect(up).not.toContain('on conflict do nothing')
    expect(up).toMatch(/where not exists \(\s*select 1 from public\.po_delivery_addresses a\s*where a\.entity = v\.entity and a\.label = v\.label\s*\);/)
  })

  it('corrects the Group postcode against Echo Barrier\'s own documents', () => {
    expect(up).toContain("replace(address, 'IP33 3TG', 'IP33 3TF')")
    // GB-BSE was inserted live on 21 Sep as a copy of the Group row, so the
    // correction has to reach both or they drift apart.
    expect(up).toContain("where entity in ('EB-GROUP', 'GB-BSE') and address like '%IP33 3TG%'")
    expect(raw).toContain('PL-A UK 10.08.2026')
  })

  it('touches no purchase order row', () => {
    expect(up).not.toMatch(/update public\.purchase_orders|delete from public\.purchase_orders/i)
  })

  it('runs in one transaction', () => {
    expect(up.trim().startsWith('begin;')).toBe(true)
    expect(up.trim().endsWith('commit;')).toBe(true)
  })
})

describe('the raising rollback', () => {
  it('exists', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
  })

  const downRaw = existsSync(join(process.cwd(), DOWN)) ? readFileSync(join(process.cwd(), DOWN), 'utf8') : ''
  const down = stripComments(downRaw)

  it('puts all three functions back the way 20260914140000 left them', () => {
    const body = fn(down, 'hub_po_prefix_for_depot')
    const pairs = Object.fromEntries([...body.matchAll(/when '([^']+)' then '([A-Z]+)'/g)].map((m) => [m[1], m[2]]))
    expect(pairs).toEqual({ 'US-BAL': 'EBUSA', 'US-SBD': 'EBUSA', 'CA-HAM': 'EBCAN', 'EU-FR': 'EBFRA', 'AU-SYD': 'EBAUS' })
    const mint = fn(down, 'hub_mint_po_number')
    expect(mint).not.toContain('po_number_seq_ebuk')
    expect(mint).not.toContain('po_number_seq_ebsro')
    expect(fn(down, 'po_guard_number_update')).not.toContain('|UK|')
  })

  it('replaces the functions before dropping the sequences they called', () => {
    expect(down.indexOf('create or replace function public.hub_mint_po_number')).toBeLessThan(
      down.indexOf('drop sequence if exists public.po_number_seq_ebuk'),
    )
  })

  it('removes the two placeholder addresses, keeps GB-BSE and every minted number', () => {
    // GB-BSE was inserted live at Dean's request before the migration ran;
    // undoing the migration must not take away a row it did not add.
    expect(down).toContain("delete from public.po_delivery_addresses where entity in ('EU-FR', 'AU-SYD');")
    expect(down).not.toMatch(/delete from public\.po_delivery_addresses[^;]*GB-BSE/)
    expect(down).not.toMatch(/update public\.purchase_orders|delete from public\.purchase_orders/i)
    expect(downRaw).not.toContain('—')
  })

  it('does not put the wrong postcode back', () => {
    expect(down).not.toContain("replace(address, 'IP33 3TF', 'IP33 3TG')")
  })
})

describe('what the Hub hands n8n', () => {
  const decide = readFileSync(join(process.cwd(), 'src/app/actions/purchase-orders/decide-po.ts'), 'utf8')
  /** Without the comments, so the prose explaining the old fault cannot satisfy
   *  or trip an assertion about the code. */
  const code = decide
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .join('\n')

  it('sends the Xero organisation and the item code, so n8n has nothing to decide', () => {
    // 🔴 n8n Fz7xXgifva5n548u picked the tenant with
    // `from_entity === 'CA-HAM' ? Canada : USA` and the code column with
    // `let codeCol = "code_usa_balt"`. Syncing a fourth copy of the map would
    // have left it free to drift again; sending the answers removes the
    // decision from n8n entirely.
    expect(decide).toContain('xero_tenant_id:')
    expect(decide).toContain('xero_item_code: codeFor(l.sku)')
    expect(decide).toContain('raising_party: party?.code ?? null')
  })

  it('reads the tenant from entities rather than writing a uuid into the code', () => {
    // Every tenant has been in public.entities since the table was created.
    expect(code).toMatch(/from\("entities"\)\s*\.select\("xero_tenant_id"\)/)
    // No Xero tenant uuid may be hardcoded in the Hub.
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('resolves the code through the registry, not a map of its own', () => {
    expect(code).toContain('raisingParty(po.from_entity)')
    expect(code).toContain('xeroItemCode(party, codesByInternal.get(internal))')
    // No depot-to-column map of its own, anywhere in the executable code.
    expect(code).not.toMatch(/code_usa_balt|code_canada|code_france|code_uk\b/)
  })
})
