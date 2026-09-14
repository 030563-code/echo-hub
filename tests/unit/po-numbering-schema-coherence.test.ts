import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PO_PREFIX_BY_DEPOT } from '@/lib/po-number'

/**
 * The numbering migration and the TypeScript that speaks to it must agree.
 *
 * Same genre as stock-schema-coherence.test.ts: read the migration and pin the
 * parts the Hub relies on. Above all: every series starts at 8001, only the
 * trigger can mint (the functions and sequences are closed to anon and
 * authenticated), s.r.o.'s documents take the digits of their Group order, an
 * older chain falls back to the PO- series, and the depot map in SQL is the
 * one in src/lib/po-number.ts.
 */

const MIG = 'supabase/migrations/20260914140000_po_numbering_scheme.sql'
const DOWN = 'supabase/migrations/rollback/20260914140000_po_numbering_scheme.down.sql'

/** SQL without its comments, so prose cannot satisfy or trip a check. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

/** The whole CREATE FUNCTION statement for one function, header and body. */
function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
  const bodyOpen = sql.indexOf('$$', start)
  const bodyClose = sql.indexOf('$$;', bodyOpen + 2)
  expect(bodyClose, `${name} body not closed`).toBeGreaterThan(bodyOpen)
  return sql.slice(start, bodyClose + 3)
}

const SEQUENCES = ['ebusa', 'ebcan', 'ebfra', 'ebaus', 'ebgrp'].map((s) => `public.po_number_seq_${s}`)

const raw = readFileSync(join(process.cwd(), MIG), 'utf8')
const up = stripComments(raw)

describe('po numbering migration', () => {
  it('carries the house header and no em-dash', () => {
    expect(raw).toContain('Applied live via MCP apply_migration on korylyniwsqtsvzuzydg')
    expect(raw).toContain('Never db push.')
    expect(raw).not.toContain('\u2014')
  })

  it('creates the five series, each starting at 8001', () => {
    const created = [...up.matchAll(/create sequence (public\.po_number_seq_\w+) as bigint start with (\d+) minvalue (\d+) no cycle;/g)]
    expect(created.map((m) => m[1]).sort()).toEqual([...SEQUENCES].sort())
    for (const m of created) {
      expect(m[2]).toBe('8001')
      expect(m[3]).toBe('8001')
    }
  })

  it('closes every new sequence to public, anon and authenticated and grants nothing', () => {
    const m = up.match(/revoke all on sequence((?:\s*public\.po_number_seq_\w+,?)+)\s*from public, anon, authenticated;/)
    expect(m, 'sequence revoke not found').toBeTruthy()
    const revoked = [...(m?.[1] ?? '').matchAll(/public\.po_number_seq_\w+/g)].map((x) => x[0]).sort()
    expect(revoked).toEqual([...SEQUENCES].sort())
    expect(up).not.toMatch(/\bgrant\b/i)
  })

  it('maps exactly the depots the TypeScript maps, to the same series', () => {
    const body = fn(up, 'hub_po_prefix_for_depot')
    const pairs = Object.fromEntries([...body.matchAll(/when '([^']+)' then '([A-Z]+)'/g)].map((m) => [m[1], m[2]]))
    expect(pairs).toEqual({ ...PO_PREFIX_BY_DEPOT })
    expect(pairs).toEqual({ 'US-BAL': 'EBUSA', 'US-SBD': 'EBUSA', 'CA-HAM': 'EBCAN', 'EU-FR': 'EBFRA', 'AU-SYD': 'EBAUS' })
  })

  it('refuses an unmapped depot instead of falling back to a prefix', () => {
    const body = fn(up, 'hub_po_prefix_for_depot')
    expect(body).not.toMatch(/\belse\b/)
    expect(body).toMatch(/if v_prefix is null then\s+raise exception 'Depot % has no purchase order number series\./)
    expect(up).toMatch(/revoke all on function public\.hub_po_prefix_for_depot\(text\) from public, anon, authenticated;/)
  })

  it('mints as a security definer with a pinned search_path, closed to anon and authenticated', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/^create or replace function public\.hub_mint_po_number\(p_leg text, p_from text, p_parent_po_id uuid\)\s+returns text/)
    expect(mint).toMatch(/\bsecurity definer\s+set search_path = public, pg_temp\s+as \$\$/)
    expect(up).toMatch(/revoke all on function public\.hub_mint_po_number\(text, text, uuid\) from public, anon, authenticated;/)
  })

  it('numbers a depot order from its own series', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/if p_leg = 'DEPOT_TO_EB_GROUP' then\s+v_prefix := public\.hub_po_prefix_for_depot\(p_from\);/)
    for (const prefix of ['EBUSA', 'EBCAN', 'EBFRA', 'EBAUS']) {
      expect(mint).toMatch(
        new RegExp(`v_prefix = '${prefix}' then\\s+return v_prefix \\|\\| nextval\\('public\\.po_number_seq_${prefix.toLowerCase()}'\\);`),
      )
    }
  })

  it('numbers a Group order EBGRP from its series, whatever its parent', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/if p_leg = 'EB_GROUP_TO_SRO' then\s+return 'EBGRP' \|\| nextval\('public\.po_number_seq_ebgrp'\);/)
  })

  it('derives EBSRO<n>-1 and -2 from the parent SRO order numbered EBGRP<n>', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/if p_leg in \('SRO_TO_SUPPLIER', 'SRO_TO_CARGO'\) then/)
    expect(mint).toMatch(/from public\.purchase_orders po\s+where po\.id = p_parent_po_id;/)
    expect(mint).toContain("v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');")
    expect(mint).toMatch(
      /if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then\s+return 'EBSRO' \|\| v_digits \|\| case p_leg when 'SRO_TO_SUPPLIER' then '-1' else '-2' end;/,
    )
    // s.r.o.'s documents never consume a sequence of their own.
    expect(mint).not.toMatch(/po_number_seq_ebsro/)
  })

  it('falls back to the old PO- series under a chain from before the scheme', () => {
    const mint = fn(up, 'hub_mint_po_number')
    const derive = mint.indexOf("return 'EBSRO'")
    const fallback = mint.indexOf('return public.generate_po_number();')
    expect(derive).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(derive)
    // Exactly one fallback, and it sits inside the s.r.o. branch, before the final refusal.
    expect(mint.match(/generate_po_number\(\)/g)).toHaveLength(1)
    expect(fallback).toBeLessThan(mint.indexOf("raise exception 'No purchase order number series for leg %.'"))
  })

  it('refuses an s.r.o. document with no parent, and any other leg', () => {
    const mint = fn(up, 'hub_mint_po_number')
    expect(mint).toMatch(/if p_parent_po_id is null then\s+raise exception/)
    expect(mint).toMatch(/if not found then\s+raise exception/)
    expect(mint).toMatch(/raise exception 'No purchase order number series for leg %\.'/)
  })

  it('makes the trigger a security definer that mints only when po_number is blank', () => {
    const trig = fn(up, 'po_before_insert')
    expect(trig).toMatch(/returns trigger\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp/)
    expect(trig).toMatch(
      /if new\.po_number is null or new\.po_number = '' then\s+new\.po_number := public\.hub_mint_po_number\(new\.leg, new\.from_entity, new\.parent_po_id\);/,
    )
    expect(trig).not.toMatch(/generate_po_number/)
    // master_ref rules unchanged: a root starts its chain, a child inherits.
    expect(trig).toMatch(/new\.master_ref := 'MR-' \|\| new\.po_number;/)
    expect(trig).toMatch(/select master_ref into new\.master_ref\s+from public\.purchase_orders\s+where id = new\.parent_po_id;/)
  })

  it('asserts the unique guarantees instead of assuming them', () => {
    expect(up).toMatch(/conname = 'purchase_orders_po_number_key'\s+and contype = 'u'/)
    expect(up).toMatch(/indexname = 'purchase_orders_parent_leg_uidx'/)
    // Both already exist live, so nothing new is created on the table.
    expect(up).not.toMatch(/create unique index/i)
    expect(up).not.toMatch(/alter table/i)
    // The assertion runs before anything is created.
    expect(up.indexOf('purchase_orders_po_number_key')).toBeLessThan(up.indexOf('create sequence'))
  })

  it('leaves existing numbers and the old series alone', () => {
    expect(up).not.toMatch(/update public\.purchase_orders/i)
    expect(up).not.toMatch(/generate_po_number\(\)\s*returns/)
    expect(up).not.toMatch(/po_number_seq\b(?!_)/)
  })
})

describe('po numbering rollback', () => {
  it('exists', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
  })

  const downRaw = existsSync(join(process.cwd(), DOWN)) ? readFileSync(join(process.cwd(), DOWN), 'utf8') : ''
  const down = stripComments(downRaw)

  it('restores the previous trigger: security invoker, minting from generate_po_number()', () => {
    const start = down.indexOf('create or replace function public.po_before_insert()')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = down.indexOf('$function$;', start)
    const trig = down.slice(start, end)
    expect(trig).toMatch(/returns trigger\s+language plpgsql\s+security invoker\s+as \$function\$/)
    expect(trig).toContain('NEW.po_number := public.generate_po_number();')
    expect(trig).toContain("NEW.master_ref := 'MR-' || NEW.po_number;")
    expect(trig).not.toMatch(/hub_mint_po_number|search_path|security definer/i)
    expect(down).toMatch(/alter function public\.po_before_insert\(\) reset all;/)
  })

  it('replaces the trigger before dropping what the new one calls', () => {
    const replaced = down.indexOf('create or replace function public.po_before_insert()')
    expect(replaced).toBeLessThan(down.indexOf('drop function if exists public.hub_mint_po_number(text, text, uuid);'))
    expect(down.indexOf('drop function if exists public.hub_mint_po_number')).toBeLessThan(
      down.indexOf('drop function if exists public.hub_po_prefix_for_depot(text);'),
    )
  })

  it('drops all five sequences', () => {
    const m = down.match(/drop sequence if exists((?:\s*public\.po_number_seq_\w+,?)+)\s*;/)
    expect(m, 'sequence drop not found').toBeTruthy()
    const dropped = [...(m?.[1] ?? '').matchAll(/public\.po_number_seq_\w+/g)].map((x) => x[0]).sort()
    expect(dropped).toEqual([...SEQUENCES].sort())
  })

  it('keeps numbers already minted', () => {
    expect(down).not.toMatch(/update public\.purchase_orders|delete from public\.purchase_orders/i)
    expect(downRaw).not.toContain('\u2014')
  })
})
