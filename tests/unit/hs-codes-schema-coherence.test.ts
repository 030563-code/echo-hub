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

  it('seeds Canada prices only for USA-priced products that have a Canada product code, without overwriting', () => {
    // H10: the HS codes tab counts a missing Canada code only where a Canada
    // price exists, so a price seeded for a product never sold to Canada would
    // demand a code for nothing. "Sold to Canada" is a non-null code_canada,
    // reached through po_product_catalog.internal_sku as the n8n workflow does.
    expect(up).toContain(
      "insert into public.intercompany_prices (sku, leg, unit_value, currency, active) select p.sku, 'GROUP_TO_CANADA', p.unit_value, p.currency, p.active from public.intercompany_prices p where p.leg = 'GROUP_TO_USA' and exists ( select 1 from public.po_product_catalog c join public.product_code_master m on m.internal_sku = c.internal_sku where c.sku = p.sku and m.code_canada is not null ) on conflict (sku, leg) do nothing;",
    )
    expect(up).not.toMatch(/select sku, 'GROUP_TO_CANADA', unit_value, currency, active from public\.intercompany_prices where leg = 'GROUP_TO_USA' on conflict/)
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

  it('changes grants only on its two functions, and adds no policies', () => {
    expect(up).not.toMatch(/create policy|drop policy|row level security/i)
    const grantsAndRevokes = [...up.matchAll(/\b(grant|revoke)\b[^;]*;/gi)].map((m) => m[0])
    expect(grantsAndRevokes).toEqual([
      'revoke all on function public.hub_issue_commercial_invoice(uuid) from public, anon, authenticated;',
      'grant execute on function public.hub_issue_commercial_invoice(uuid) to service_role;',
      'revoke all on function public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb) from public, anon, authenticated;',
      'grant execute on function public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb) to service_role;',
    ])
  })

  /** One function's body, from its create to the end of its dollar quote. */
  function fn(name: string): string {
    const m = up.match(new RegExp(`create or replace function public\\.${name}\\([^)]*\\) returns jsonb [\\s\\S]*? \\$\\$ ([\\s\\S]*?) \\$\\$;`))
    return m?.[0] ?? ''
  }

  it('issues a draft in hub_issue_commercial_invoice, under a row lock, only when every line has a code', () => {
    const body = fn('hub_issue_commercial_invoice')
    expect(body, 'hub_issue_commercial_invoice not found').not.toBe('')
    expect(body).toContain('create or replace function public.hub_issue_commercial_invoice(p_invoice_id uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$')
    // The lock comes first, then the draft check, then the HS code check, then the flip.
    const lock = body.indexOf('from public.commercial_invoices ci where ci.id = p_invoice_id for update;')
    const draft = body.indexOf("if v_status <> 'draft' then")
    const codes = body.indexOf("and (l.hs_code is null or l.hs_code !~ '[^[:space:]]');")
    const refuse = body.indexOf("'reason', 'missing_hs_codes', 'missing_skus', v_missing")
    const flip = body.indexOf("update public.commercial_invoices set status = 'issued' where id = p_invoice_id;")
    for (const [name, at] of Object.entries({ lock, draft, codes, refuse, flip })) expect(at, name).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(draft)
    expect(draft).toBeLessThan(codes)
    expect(codes).toBeLessThan(refuse)
    expect(refuse).toBeLessThan(flip)
  })

  it('replaces a draft\'s lines and totals in hub_replace_commercial_invoice_lines, under the same row lock', () => {
    const body = fn('hub_replace_commercial_invoice_lines')
    expect(body, 'hub_replace_commercial_invoice_lines not found').not.toBe('')
    expect(body).toContain('create or replace function public.hub_replace_commercial_invoice_lines(p_invoice_id uuid, p_lines jsonb, p_header jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$')
    const lock = body.indexOf('from public.commercial_invoices ci where ci.id = p_invoice_id for update;')
    const draft = body.indexOf("if v_status <> 'draft' then")
    const del = body.indexOf('delete from public.commercial_invoice_lines where invoice_id = p_invoice_id;')
    const ins = body.indexOf('insert into public.commercial_invoice_lines (invoice_id, sku, product_name, qty, unit_value, line_total, hs_code, container_ref, sort_order)')
    const totals = body.indexOf("update public.commercial_invoices set subtotal = (p_header->>'subtotal')::numeric, total = (p_header->>'total')::numeric, updated_at = now() where id = p_invoice_id;")
    for (const [name, at] of Object.entries({ lock, draft, del, ins, totals })) expect(at, name).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(draft)
    expect(draft).toBeLessThan(del)
    expect(del).toBeLessThan(ins)
    expect(ins).toBeLessThan(totals)
    // The lines take the locked row's container, never the payload's.
    expect(body).toContain("(l->>'line_total')::numeric, l->>'hs_code', v_container,")
  })

  it('is the only way the app issues a draft or replaces its lines', () => {
    const status = readFileSync(join(process.cwd(), 'src/app/actions/invoices/set-invoice-status.ts'), 'utf8')
    const edit = readFileSync(join(process.cwd(), 'src/app/actions/invoices/edit-invoice-draft.ts'), 'utf8')
    expect(status).toContain('admin.rpc("hub_issue_commercial_invoice", { p_invoice_id: invoice_id })')
    expect(edit).toContain('admin.rpc("hub_replace_commercial_invoice_lines", {')
    expect(edit).not.toMatch(/from\("commercial_invoice_lines"\)\s*\.(delete|insert|update|upsert)\(/)
    expect(edit).not.toMatch(/from\("commercial_invoices"\)\s*\.update\(/)
  })

  it('has a rollback that reverses every statement and deletes only what it inserted', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
    const down = oneLine(stripComments(readFileSync(join(process.cwd(), DOWN), 'utf8')))
    for (const needle of [
      'drop function if exists public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb);',
      'drop function if exists public.hub_issue_commercial_invoice(uuid);',
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
