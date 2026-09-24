import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  RAISING_PARTIES,
  RAISABLE_PARTIES,
  DEPOT_MAPPING_COLUMNS,
  canRaiseFor,
  catalogueFor,
  raisingBlockedReason,
  raisingParty,
  xeroItemCodeFor,
  type DepotProduct,
} from '@/lib/po-raising'
import { PO_PREFIX_BY_DEPOT, isNewSchemePoNumber } from '@/lib/po-number'

/**
 * Who may raise a purchase order, in one table; what each may order, in one
 * table of the database; and the migration that agrees with both.
 *
 * 🔴 THE FAULT THIS EXISTS TO PREVENT. The same facts were written out four
 * times: V1_DEPOTS on the create page, DEPOT_CODE_COL in the form,
 * PO_PREFIX_BY_DEPOT here, and a `let codeCol = "code_usa_balt"` with three ifs
 * inside n8n Fz7xXgifva5n548u. The fourth one is the one Xero actually obeys,
 * and it DEFAULTED, so a French order would have been created in the United
 * States Xero organisation carrying US Baltimore item codes.
 *
 * And the second fault, 22 Sep 2026: the product list came from
 * po_product_catalog, sixteen North American SKUs, so France was offered EBH9NA
 * where its own SKU (and its stock rows) are EBH9. Dean: "remember we have the
 * region specific codes in product_depot_mapping in supabase already for each
 * depot." That table is the only product source now.
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
const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')
const codeOnly = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .join('\n')

// A product_depot_mapping shaped fixture, taken from the live table on 22 Sep 2026.
const row = (
  depot_code: string,
  hubspot_sku_code: string | null,
  xero_item_code: string,
  xero_item_description: string,
  product_family: string,
  is_active = true,
): DepotProduct => ({ depot_code, hubspot_sku_code, xero_item_code, xero_item_description, product_family, is_active })

const MAPPING: DepotProduct[] = [
  row('US-BAL', 'EBH9NA', 'H9BALT', 'Echo Barrier H9', 'H9'),
  // The live V2 Baltimore code really does carry trailing spaces.
  row('US-BAL', 'V2NA', 'V2BALT  ', 'Echo Barrier V2', 'V2'),
  row('US-BAL', 'EBVFKNA', 'VFKB', 'Verticale Fitting Kits', 'Accessories'),
  row('US-SBD', 'EBH9NA', 'H9SB', 'Echo Barrier H9', 'H9'),
  row('US-SBD', 'EBH9ERNA', 'H9SBXR', 'Echo Barrier H9 Ex Rental', 'H9'),
  row('CA-HAM', 'EBH9NA', 'H9HAM', 'Echo Barrier H9', 'H9'),
  row('CA-HAM', 'EBH10HERC', 'H10HERCHAM', 'Echo Barrier H10 Black with HERC Logo', 'H10', false),
  row('EU-FR', 'EBH9', 'H9', 'Echo Barrier H9', 'H9'),
  row('EU-FR', 'V2', 'V2', 'V2', 'V2'),
  row('GB-BSE', 'EBH9', '01-EBH9', 'Echo Barrier H9', 'H9'),
  row('GB-BSE', 'NDS', '01-NDS', 'Noise Defender Single', 'Noise Defender'),
  row('EB-GROUP', 'EBH9', '01-EBH9', 'Echo Barrier H9', 'H9'),
  row('EB-SRO', 'EBH9SK', 'H9SK', 'Echo Barrier H9', 'H9'),
  row('EB-SRO', 'BLANK', '   ', 'A row with no code', 'H9'),
  // Dean, 22 Sep 2026: every Xero item is orderable "even if they dont have a
  // hubspot sku code". A shipping line and an ex-rental charge never get one.
  row('EU-FR', null, 'LTL-FR-001', 'Shipping', 'Accessories'),
  row('US-BAL', null, 'ADMIN-FEE', 'Administration charge', 'Accessories'),
  // Two HubSpot SKUs pointing at ONE Xero item, which the live Baltimore data
  // really does: EBH10HERC and EBH10HERCNA both mean H10HERCB.
  row('CA-HAM', 'EBH10HERCNA', 'H10HERCHAM', 'H10 Herc Logo', 'H10'),
]
const skusFor = (code: string) => catalogueFor(raisingParty(code)!, MAPPING).map((p) => p.sku)

describe('the raising registry', () => {
  it('carries the four parties Dean asked for, on their own legs', () => {
    expect(raisingParty('EU-FR')).toMatchObject({ leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-FRANCE', series: 'EBFRA' })
    expect(raisingParty('GB-BSE')).toMatchObject({ leg: 'DEPOT_TO_EB_GROUP', to: 'EB-GROUP', org: 'EB-UK', series: 'EBUK' })
    // Group and s.r.o. are not depots and do not raise the depot leg.
    expect(raisingParty('EB-GROUP')).toMatchObject({ leg: 'EB_GROUP_TO_SRO', to: 'EB-SRO', org: 'EB-GROUP', series: 'EBGRP' })
    expect(raisingParty('EB-SRO')).toMatchObject({ leg: 'SRO_TO_SUPPLIER', to: 'SUPPLIER', org: 'EB-SRO', series: 'EBSRO' })
  })

  it('never defaults: an unmapped party refuses and says who can', () => {
    expect(raisingParty('EU-SK')).toBeNull()
    expect(canRaiseFor('EU-SK')).toBe(false)
    expect(raisingBlockedReason('EU-SK')).toContain('cannot raise purchase orders')
    expect(raisingBlockedReason('EU-SK')).toContain('EU-FR')
    expect(raisingBlockedReason(null)).toContain('(blank)')
    expect(raisingBlockedReason('')).toContain('(blank)')
  })

  it('lists Australia, and offers it nothing until the mapping has rows for it', () => {
    // A series and a Xero organisation, and no rows in product_depot_mapping
    // on 22 Sep 2026. That is a fact about the data; the form says so.
    expect(canRaiseFor('AU-SYD')).toBe(true)
    expect(RAISABLE_PARTIES.map((p) => p.code)).toContain('AU-SYD')
    expect(skusFor('AU-SYD')).toEqual([])
    expect(read('src/app/(dashboard)/purchase-orders/create/raise-po-form.tsx')).toContain('`Nothing mapped for ${party.label}`')
  })

  it('is case and whitespace tolerant on the way in', () => {
    expect(raisingParty(' eu-fr ')?.code).toBe('EU-FR')
  })

  it('gives every party a distinct code and a series', () => {
    const codes = RAISING_PARTIES.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const p of RAISING_PARTIES) expect(p.series, p.code).toMatch(/^EB[A-Z]+$/)
  })
})

describe('the depot-specific line items come from product_depot_mapping', () => {
  it("offers each party its own region's SKUs, and never the North American ones to France", () => {
    // Dean, 21 Sep 2026: "The line items have to be loaded depot specific."
    // Dean, 22 Sep 2026: "when I go to France it still shows the US/NA hubspot_sku_codes".
    // Sorted by family then by the XERO code, which is the identity now.
    expect(skusFor('EU-FR')).toEqual(['LTL-FR-001', 'EBH9', 'V2'])
    expect(skusFor('GB-BSE')).toEqual(['EBH9', 'NDS'])
    expect(skusFor('EB-GROUP')).toEqual(['EBH9'])
    expect(skusFor('US-BAL')).toEqual(['ADMIN-FEE', 'EBVFKNA', 'EBH9NA', 'V2NA'])
    expect(skusFor('EU-FR')).not.toContain('EBH9NA')
  })

  it('gives the code the party\'s OWN Xero organisation knows the line under', () => {
    expect(xeroItemCodeFor(raisingParty('EU-FR')!, 'EBH9', MAPPING)).toBe('H9')
    expect(xeroItemCodeFor(raisingParty('GB-BSE')!, 'EBH9', MAPPING)).toBe('01-EBH9')
    expect(xeroItemCodeFor(raisingParty('US-BAL')!, 'EBH9NA', MAPPING)).toBe('H9BALT')
    // San Bernardino's ex-rental H9 has its own code, which a per-country
    // column on the code master could never say.
    expect(xeroItemCodeFor(raisingParty('US-SBD')!, 'EBH9ERNA', MAPPING)).toBe('H9SBXR')
    expect(xeroItemCodeFor(raisingParty('US-SBD')!, 'EBH9NA', MAPPING)).toBe('H9SB')
  })

  it('returns null for a SKU the party does not map, and never another party\'s code', () => {
    expect(xeroItemCodeFor(raisingParty('EU-FR')!, 'EBH9NA', MAPPING)).toBeNull()
    expect(xeroItemCodeFor(raisingParty('AU-SYD')!, 'EBH9', MAPPING)).toBeNull()
  })

  it('trims the code, skips a retired row and a row with no code', () => {
    // A Xero ItemCode with a trailing space does not match the item.
    expect(xeroItemCodeFor(raisingParty('US-BAL')!, 'V2NA', MAPPING)).toBe('V2BALT')
    expect(skusFor('CA-HAM')).toEqual(['EBH10HERCNA', 'EBH9NA'])
    expect(skusFor('EB-SRO')).toEqual(['EBH9SK'])
  })

  it('names a product by its Xero description, so the dropdown reads like the region', () => {
    const fr = catalogueFor(raisingParty('EU-FR')!, MAPPING)
    expect(fr.map((p) => [p.sku, p.product_name, p.product_family])).toEqual([
      ['LTL-FR-001', 'Shipping', 'Accessories'],
      ['EBH9', 'Echo Barrier H9', 'H9'],
      ['V2', 'V2', 'V2'],
    ])
  })

  // Dean, 22 Sep 2026: "pull through all xero_item_codes for all organisations
  // onto the product_depot_mapping table even if they dont have a hubspot sku
  // code ... And also when you select the line items dropdown it should show the
  // Xero item code instead of the hubspot sku code."
  describe('a product with no HubSpot SKU', () => {
    it('is offered, because the Xero item code is the identity', () => {
      const fr = catalogueFor(raisingParty('EU-FR')!, MAPPING)
      const shipping = fr.find((p) => p.xeroItemCode === 'LTL-FR-001')
      expect(shipping).toBeDefined()
      expect(shipping!.hubspotSku).toBeNull()
      // The order line has to carry something, and the Xero code is the only
      // identifier such a product has.
      expect(shipping!.sku).toBe('LTL-FR-001')
      expect(shipping!.product_name).toBe('Shipping')
    })

    it('still refuses a row with no Xero code, because the line would vanish in Xero', () => {
      // n8n drops an unmapped line into unmapped_skus and carries on, so the
      // order would reach Xero missing a line and nobody would be told.
      expect(skusFor('EB-SRO')).not.toContain('BLANK')
    })

    it('every product carries the code Xero will receive, whether or not it has a SKU', () => {
      for (const party of ['EU-FR', 'US-BAL', 'CA-HAM', 'GB-BSE', 'EB-SRO', 'EB-GROUP']) {
        for (const p of catalogueFor(raisingParty(party)!, MAPPING)) {
          expect(p.xeroItemCode, `${party} ${p.sku}`).toBeTruthy()
          expect(p.xeroItemCode).toBe(p.xeroItemCode.trim())
        }
      }
    })
  })

  describe('two SKUs pointing at one Xero item', () => {
    it('offers the item once, because a repeat is a choice that is not one', () => {
      // Live data: EBH10HERC and EBH10HERCNA both mean H10HERCHAM at Hamilton,
      // and the first of them is switched off.
      const ham = catalogueFor(raisingParty('CA-HAM')!, MAPPING)
      const herc = ham.filter((p) => p.xeroItemCode === 'H10HERCHAM')
      expect(herc).toHaveLength(1)
      expect(herc[0].hubspotSku).toBe('EBH10HERCNA')
    })

    it('never offers a product twice under one Xero code, for any party', () => {
      for (const party of ['EU-FR', 'US-BAL', 'US-SBD', 'CA-HAM', 'GB-BSE', 'EB-SRO', 'EB-GROUP']) {
        const codes = catalogueFor(raisingParty(party)!, MAPPING).map((p) => p.xeroItemCode)
        expect(new Set(codes).size, party).toBe(codes.length)
      }
    })
  })

  it('the dropdown shows the Xero item code, not the HubSpot SKU', () => {
    const form = read('src/app/(dashboard)/purchase-orders/create/raise-po-form.tsx')
    const option = form.slice(form.indexOf('{items.map('), form.indexOf('</optgroup>'))
    expect(option).toContain('{c.xeroItemCode}')
    expect(option).not.toMatch(/>\s*\{c\.sku\}/)
    // The value stays the line identity, which is what the order carries.
    expect(option).toContain('value={c.sku}')
  })

  it('is read from the same columns by every reader, and nothing reads the old tables for it', () => {
    for (const col of ['depot_code', 'hubspot_sku_code', 'xero_item_code', 'xero_item_description', 'product_family', 'is_active']) {
      expect(DEPOT_MAPPING_COLUMNS).toContain(col)
    }
    for (const file of [
      'src/app/(dashboard)/purchase-orders/create/page.tsx',
      'src/app/actions/purchase-orders/create-po.ts',
      // The Xero payload moved here from decide-po on 24 Sep 2026, so the
      // approval and "Send to Xero again" build it in one place.
      'src/app/actions/purchase-orders/xero-handoff.ts',
    ]) {
      const src = codeOnly(read(file))
      expect(src, file).toContain('from("product_depot_mapping")')
      expect(src, file).toContain('DEPOT_MAPPING_COLUMNS')
      expect(src, file).not.toContain('product_code_master')
      expect(src, file).not.toContain('po_product_catalog')
    }
    expect(codeOnly(read('src/app/(dashboard)/purchase-orders/create/raise-po-form.tsx'))).not.toContain('product_code_master')
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
  // Built in the hand-off module since 24 Sep 2026: decide-po and the retry
  // action both call it, so neither can drift from what the other sends.
  const decide = read('src/app/actions/purchase-orders/xero-handoff.ts')
  /** Without the comments, so the prose explaining the old fault cannot satisfy
   *  or trip an assertion about the code. */
  const code = codeOnly(decide)

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

  it("resolves the code through the party's own mapping rows, not a map of its own", () => {
    expect(code).toContain('raisingParty(po.from_entity)')
    expect(code).toContain('xeroItemCodeFor(party, sku, (mapping ?? []) as DepotProduct[])')
    expect(code).toMatch(/\.eq\("depot_code", party\?\.code \?\? ""\)/)
    // No depot-to-column map of its own, anywhere in the executable code.
    expect(code).not.toMatch(/code_usa_balt|code_canada|code_france|code_uk\b/)
  })
})
