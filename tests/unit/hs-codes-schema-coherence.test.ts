import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INVOICE_LEGS, LEG_CONFIG } from '@/lib/invoice-legs'
import { HS_CODE_MAX_DIGITS, HS_CODE_MIN_DIGITS, HS_CODE_PATTERN } from '@/lib/hs-codes'

/**
 * The HS codes and Canada leg migration and the TypeScript that speaks to it
 * must agree.
 *
 * Same genre as profile-schema-coherence.test.ts: read the migration and pin
 * the parts the code relies on. Above all the two CHECKs: the leg list is
 * INVOICE_LEGS, and the HS code rule is the one isValidHsCode applies, so a code
 * the screen accepts is never refused by the database and the reverse.
 */

const MIG = 'supabase/migrations/20260914120000_hs_codes_canada_leg.sql'
const DOWN = 'supabase/migrations/rollback/20260914120000_hs_codes_canada_leg.down.sql'
const NOTE = 'Mirrors the Group to USA rule for Group to Canada. CONFIRM it applies to Canada.'

/** SQL without its comments, so prose cannot satisfy or trip a check. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim()

const raw = readFileSync(join(process.cwd(), MIG), 'utf8')
const up = oneLine(stripComments(raw))

describe('HS codes and Canada leg migration', () => {
  it('carries the house header', () => {
    expect(raw).toContain('Applied live via MCP apply_migration on korylyniwsqtsvzuzydg')
    expect(raw).toContain('Never db push.')
  })

  it('contains no em-dash', () => {
    expect(raw).not.toContain('\u2014')
    expect(existsSync(join(process.cwd(), DOWN)) ? readFileSync(join(process.cwd(), DOWN), 'utf8') : '').not.toContain('\u2014')
  })

  it('inserts EB-CANADA with placeholders, in CAD, once', () => {
    expect(up).toContain(
      "insert into public.entities (code, legal_name, address_lines, vat_tax_id, eori, default_currency) values ('EB-CANADA', 'Echo Barrier Canada, Inc', array['Confirm registered address'], null, null, 'CAD') on conflict (code) do nothing;",
    )
    // No existing entity carries a Xero tenant id, so neither does this one.
    expect(up).not.toMatch(/xero_tenant_id|xero_contact_id/)
  })

  it('names the same buyer and currency the Canada leg uses', () => {
    expect(LEG_CONFIG.GROUP_TO_CANADA.buyer).toBe('EB-CANADA')
    expect(LEG_CONFIG.GROUP_TO_CANADA.currency).toBe('CAD')
    expect(LEG_CONFIG.GROUP_TO_CANADA.fxPair).toBe('EUR_CAD')
  })

  it('seeds Canada prices from every Group to USA EUR base, without overwriting', () => {
    expect(up).toContain(
      "insert into public.intercompany_prices (sku, leg, unit_value, currency, active) select sku, 'GROUP_TO_CANADA', unit_value, currency, active from public.intercompany_prices where leg = 'GROUP_TO_USA' on conflict (sku, leg) do nothing;",
    )
    expect(raw).toMatch(/COST-LEVEL PLACEHOLDERS\s+--\s+pending Dave and Juraj/)
  })

  it('copies each Group to USA composition rule to Group to Canada, with the confirm note, once', () => {
    expect(up).toContain(
      `insert into public.invoice_composition_rules (active, country, leg, rule_type, source_sku, config, note, priority) select r.active, r.country, 'GROUP_TO_CANADA', r.rule_type, r.source_sku, r.config, '${NOTE}', r.priority from public.invoice_composition_rules r where r.leg = 'GROUP_TO_USA' and not exists (`,
    )
  })

  it('limits product_hs_codes.leg to exactly the invoice legs', () => {
    const m = up.match(/add constraint product_hs_codes_leg_check check \(leg in \(([^)]*)\)\);/)
    expect(m, 'leg CHECK not found').toBeTruthy()
    const legs = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(legs).toEqual([...INVOICE_LEGS])
    // '*' no longer passes, so the default that wrote it has to go.
    expect(up).toContain('alter table public.product_hs_codes alter column leg drop default;')
  })

  it('checks hs_code with the same pattern and digit range as isValidHsCode', () => {
    expect(up).toContain(
      `add constraint product_hs_codes_hs_code_format check ( hs_code is null or ( hs_code ~ '${HS_CODE_PATTERN}' and length(regexp_replace(hs_code, '[^0-9]', '', 'g')) between ${HS_CODE_MIN_DIGITS} and ${HS_CODE_MAX_DIGITS} ) );`,
    )
  })

  it('changes no grants and adds no policies', () => {
    expect(up).not.toMatch(/\bgrant\b|\brevoke\b|create policy|drop policy|row level security/i)
  })

  it('has a rollback that reverses every statement and deletes only what it inserted', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
    const down = oneLine(stripComments(readFileSync(join(process.cwd(), DOWN), 'utf8')))
    for (const needle of [
      'alter table public.product_hs_codes drop constraint if exists product_hs_codes_hs_code_format;',
      'alter table public.product_hs_codes drop constraint if exists product_hs_codes_leg_check;',
      "alter table public.product_hs_codes alter column leg set default '*';",
      `delete from public.invoice_composition_rules where leg = 'GROUP_TO_CANADA' and note = '${NOTE}';`,
      "delete from public.intercompany_prices where leg = 'GROUP_TO_CANADA';",
      "delete from public.entities where code = 'EB-CANADA';",
    ]) {
      expect(down, needle).toContain(needle)
    }
    // Exactly those three deletes: nothing touches the HS codes people typed.
    expect(down.match(/\bdelete from\b/g) ?? []).toHaveLength(3)
    expect(down).not.toMatch(/delete from public\.product_hs_codes/)
    expect(down).not.toMatch(/\bdrop table\b|\btruncate\b/i)
  })
})
