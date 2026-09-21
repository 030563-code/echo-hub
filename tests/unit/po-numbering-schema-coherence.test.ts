import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PO_PREFIX_BY_DEPOT, isNewSchemePoNumber } from '@/lib/po-number'

/**
 * The numbering migration and the TypeScript that speaks to it must agree.
 *
 * Same genre as stock-schema-coherence.test.ts: read the migration and pin the
 * parts the Hub relies on. Above all: every series starts at 8001 and is wound
 * past any number already in use, only the trigger can mint (the functions and
 * sequences are closed to anon and authenticated), only a signed-in caller with
 * po.create or po.approve can spend a number and it never picks its own,
 * s.r.o.'s documents take the digits of their Group order's po_number, any
 * other parent falls back to the PO- series with a warning that names it, a
 * number minted under the scheme cannot be renamed by anyone, the service role
 * included, and the depot map in SQL is the one in src/lib/po-number.ts.
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
    expect(raw).toContain('Never db push.')
    expect(raw).not.toContain('\u2014')
  })

  it('does not claim to have been applied, and states the n8n ordering constraint', () => {
    // It had said "Applied live via MCP apply_migration" while nothing had been
    // applied. The header is the only place an operator learns the order of
    // work, so it has to be true and it has to name the workflow.
    expect(raw).not.toContain('Applied live via MCP apply_migration')
    expect(raw).toContain('NOT APPLIED when this file was written.')
    expect(raw).toContain('Fz7xXgifva5n548u')
    expect(raw).toContain('PurchaseOrderNumber')
  })

  it('creates the five series, each starting at 8001', () => {
    const created = [...up.matchAll(/create sequence (public\.po_number_seq_\w+) as bigint start with (\d+) minvalue (\d+) no cycle;/g)]
    expect(created.map((m) => m[1]).sort()).toEqual([...SEQUENCES].sort())
    for (const m of created) {
      expect(m[2]).toBe('8001')
      expect(m[3]).toBe('8001')
    }
  })

  it('winds each series past any number its prefix already carries', () => {
    // The rollback drops these sequences. Without this, re-applying restarts
    // every series at 8001 and re-issues numbers that are already purchase
    // order numbers in Xero. is_called is false so the stored value IS the
    // next one out: 8001 on a clean table, max + 1 otherwise.
    for (const prefix of ['EBUSA', 'EBCAN', 'EBFRA', 'EBAUS', 'EBGRP']) {
      const seq = `public.po_number_seq_${prefix.toLowerCase()}`
      expect(up, `${prefix} setval`).toContain(
        `select setval('${seq}', greatest(8001, coalesce((select max(substring(po_number from '^${prefix}([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^${prefix}[0-9]+$'), 8001)), false);`,
      )
      expect(up.indexOf(`create sequence ${seq} `)).toBeLessThan(up.indexOf(`setval('${seq}'`))
    }
  })

  it('closes every new sequence to public, anon and authenticated and grants nothing', () => {
    const m = up.match(/revoke all on sequence((?:\s*public\.po_number_seq_\w+,?)+)\s*from public, anon, authenticated;/)
    expect(m, 'sequence revoke not found').toBeTruthy()
    const revoked = [...(m?.[1] ?? '').matchAll(/public\.po_number_seq_\w+/g)].map((x) => x[0]).sort()
    expect(revoked).toEqual([...SEQUENCES].sort())
    expect(up).not.toMatch(/\bgrant\b/i)
  })

  it('maps the five depots it introduced, and every one still maps the same way', () => {
    const body = fn(up, 'hub_po_prefix_for_depot')
    const pairs = Object.fromEntries([...body.matchAll(/when '([^']+)' then '([A-Z]+)'/g)].map((m) => [m[1], m[2]]))
    expect(pairs).toEqual({ 'US-BAL': 'EBUSA', 'US-SBD': 'EBUSA', 'CA-HAM': 'EBCAN', 'EU-FR': 'EBFRA', 'AU-SYD': 'EBAUS' })
    // GB-BSE was added later, so this file is a SUBSET of the TypeScript map
    // rather than equal to it. po-raising-schema-coherence.test.ts pins the
    // whole of it against the migration that supersedes this function.
    for (const [depot, prefix] of Object.entries(pairs)) {
      expect(PO_PREFIX_BY_DEPOT[depot], depot).toBe(prefix)
    }
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
    // Pin the SOURCE column. The digits come from the parent's po_number, which
    // is the number Xero carries; master_ref would pass every other assertion
    // here and be wrong the moment a chain's root is not its Group order.
    expect(mint).toMatch(/select po\.leg, po\.po_number\s+into v_parent_leg, v_parent_no/)
    expect(mint).toMatch(/from public\.purchase_orders po\s+where po\.id = p_parent_po_id;/)
    expect(mint).toContain("v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');")
    expect(mint).toMatch(
      /if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then\s+return 'EBSRO' \|\| v_digits \|\| case p_leg when 'SRO_TO_SUPPLIER' then '-1' else '-2' end;/,
    )
    // s.r.o.'s documents never consume a sequence of their own.
    expect(mint).not.toMatch(/po_number_seq_ebsro/)
  })

  it('falls back to the old PO- series under any other existing parent', () => {
    const mint = fn(up, 'hub_mint_po_number')
    const derive = mint.indexOf("return 'EBSRO'")
    const fallback = mint.indexOf('return public.generate_po_number();')
    expect(derive).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(derive)
    // Exactly one fallback, and it sits inside the s.r.o. branch, before the final refusal.
    expect(mint.match(/generate_po_number\(\)/g)).toHaveLength(1)
    expect(fallback).toBeLessThan(mint.indexOf("raise exception 'No purchase order number series for leg %.'"))
    // Unconditional once the EBGRP derive has not returned. Round 1 refused
    // anything but EBGRP<n> or PO-<n>, which left the manufacturing and
    // shipping buttons dead on warm-started chains (1405, EBG26094), on
    // Xero-shaped numbers (PO-USA18139) and on test fixtures (E2EPO26005).
    const between = mint.slice(mint.indexOf('end if;', derive) + 'end if;'.length, fallback)
    expect(between).not.toMatch(/\bif\b/)
    expect(between).not.toMatch(/raise exception/)
    expect(mint).not.toMatch(/v_parent_no ~ '\^PO-/)
    expect(mint).not.toContain('is not an EBGRP order')
  })

  it('names the parent number, the parent leg and the child leg in the fallback warning', () => {
    const mint = fn(up, 'hub_mint_po_number')
    // Pin the ARGUMENTS as well as the text. The round-1 pin matched only the
    // prefix of the message, so a warning naming no parent at all still passed.
    const m = mint.match(/raise warning '([^']*)',\s*([^;]*);\s*return public\.generate_po_number\(\);/)
    expect(m, 'the warning must sit directly before the fallback').toBeTruthy()
    const [, text, args] = m ?? []
    expect(text.match(/%/g)).toHaveLength(3)
    expect(text).toMatch(/^Purchase order % \(leg %\) has no EBGRP number to derive from, so its % order takes a PO- number/)
    expect(args.split(',').map((a) => a.trim())).toEqual(['v_parent_no', 'v_parent_leg', 'p_leg'])
    // The parent's number and leg come from the parent's own row.
    expect(mint).toMatch(/select po\.leg, po\.po_number\s+into v_parent_leg, v_parent_no/)
  })

  it('never puts a purchase order id in a message', () => {
    const mint = fn(up, 'hub_mint_po_number')
    // A message that told the caller whether an id existed would be a free row
    // probe of the table. The missing-parent case says only what the caller
    // already knows: which of its own orders could not be numbered.
    expect(mint).not.toMatch(/raise exception '[^']*',[^;]*p_parent_po_id/)
    expect(mint).toMatch(
      /if not found then\s+raise exception 'The order behind this % order cannot be used to number it\.', p_leg;/,
    )
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

  it('checks who is asking BEFORE a number is spent on them', () => {
    const trig = fn(up, 'po_before_insert')
    expect(trig).toContain('v_role text := auth.role();')
    expect(trig).toMatch(/if v_role = 'anon' then\s+raise exception/)
    expect(trig).toMatch(
      /if not \(public\.has_capability\('po\.create'\) or public\.has_capability\('po\.approve'\)\) then\s+raise exception/,
    )
    // The order is the whole point: this trigger runs before RLS refuses
    // anything and nextval is not undone by the rollback that follows, so a
    // check after the mint would still let a refused insert burn a number.
    expect(trig.indexOf("v_role = 'anon'")).toBeLessThan(trig.indexOf('hub_mint_po_number'))
    expect(trig.indexOf('has_capability')).toBeLessThan(trig.indexOf('hub_mint_po_number'))
    // anon has no policy on the table, so it has no business holding writes.
    expect(up).toContain('revoke insert, update, delete, truncate on public.purchase_orders from anon;')
  })

  it('overwrites the number a session caller supplies', () => {
    const trig = fn(up, 'po_before_insert')
    expect(trig).toMatch(/if v_role = 'authenticated' then/)
    // Dropped, not merely ignored, so the rules below re-derive both. A
    // po.create holder could otherwise squat EBSRO<n>-1 and block that chain's
    // real manufacturing order for good.
    expect(trig).toMatch(/new\.po_number := null;\s+new\.master_ref := null;/)
    expect(trig.indexOf('new.po_number := null;')).toBeLessThan(trig.indexOf('hub_mint_po_number'))
  })

  it('refuses a rename from a signed-in session', () => {
    const guard = fn(up, 'po_guard_number_update')
    expect(guard).toMatch(/returns trigger\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp/)
    expect(guard).toMatch(
      /if auth\.role\(\) = 'authenticated'\s+and \(new\.po_number is distinct from old\.po_number\s+or new\.master_ref is distinct from old\.master_ref\) then\s+raise exception/,
    )
    expect(up).toMatch(
      /create trigger trg_po_number_guard\s+before update on public\.purchase_orders\s+for each row execute function public\.po_guard_number_update\(\);/,
    )
  })

  describe('refuses a rename of a scheme number from EVERY caller', () => {
    // n8n PATCHing Xero's own number over the Hub's runs as the service role,
    // which no policy or grant stops. The guard is the only thing that can.
    const guard = () => fn(up, 'po_guard_number_update')
    const NUMBER_RULE =
      /if new\.po_number is distinct from old\.po_number\s+and old\.po_number ~ '([^']+)' then\s+raise exception '([^']*)',\s*old\.po_number;/
    const REF_RULE =
      /if new\.master_ref is distinct from old\.master_ref\s+and old\.master_ref ~ '([^']+)' then\s+raise exception '([^']*)',\s*old\.master_ref;/

    it('guards po_number and master_ref with no role condition', () => {
      const g = guard()
      const num = g.match(NUMBER_RULE)
      const ref = g.match(REF_RULE)
      expect(num, 'po_number rule not found').toBeTruthy()
      expect(ref, 'master_ref rule not found').toBeTruthy()
      // Neither rule may be nested inside the authenticated check: each is its
      // own top-level if, after the session rule has closed.
      const sessionEnd = g.indexOf('end if;')
      expect(g.indexOf('if new.po_number is distinct from old.po_number')).toBeGreaterThan(sessionEnd)
      expect(g.indexOf('if new.master_ref is distinct from old.master_ref')).toBeGreaterThan(sessionEnd)
      const outsideSession = g.slice(sessionEnd)
      expect(outsideSession).not.toMatch(/auth\.role|current_user|session_user|service_role/)
    })

    it('says the number is the one Xero holds and cannot change once the order exists', () => {
      const g = guard()
      for (const rule of [NUMBER_RULE, REF_RULE]) {
        const text = g.match(rule)?.[2] ?? ''
        expect(text).toContain('the number Xero holds')
        expect(text).toContain('cannot be changed once the order exists')
      }
    })

    it('matches exactly the numbers the TypeScript calls new-scheme', () => {
      const g = guard()
      const numberPattern = new RegExp(g.match(NUMBER_RULE)?.[1] ?? '^$')
      const refPattern = new RegExp(g.match(REF_RULE)?.[1] ?? '^$')
      expect(numberPattern.source).toBe('^(EB(USA|CAN|FRA|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$')
      expect(refPattern.source).toBe('^MR-(EB(USA|CAN|FRA|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$')
      const samples = [
        'EBUSA8001', 'EBCAN8001', 'EBFRA8001', 'EBAUS8001', 'EBGRP8001', 'EBSRO8001-1', 'EBSRO8001-2', 'EBSRO8001-3',
        'EBSRO8001-4', 'EBSRO8001', 'EBGRP', 'EBG26086', 'EBG26094', 'EBUSA26013x', 'PO-01224', 'PO-USA18139',
        '1405', 'E2EPO26005', 'MRPD-20260914-01', 'xEBUSA8001', '',
      ]
      // EBUK is deliberately absent: it joined the scheme in a later migration,
      // which po-raising-schema-coherence.test.ts pins. Everything this
      // migration knew about still agrees with the TypeScript.
      expect(samples.some((n) => n.startsWith('EBUK'))).toBe(false)
      for (const n of samples) {
        expect(numberPattern.test(n), n).toBe(isNewSchemePoNumber(n))
        expect(refPattern.test(`MR-${n}`), `MR-${n}`).toBe(isNewSchemePoNumber(n))
      }
    })
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

  it('drops the rename guard with the scheme it protected', () => {
    expect(down).toContain('drop trigger if exists trg_po_number_guard on public.purchase_orders;')
    expect(down).toContain('drop function if exists public.po_guard_number_update();')
    expect(down.indexOf('drop trigger if exists trg_po_number_guard')).toBeLessThan(
      down.indexOf('drop function if exists public.po_guard_number_update()'),
    )
  })

  it('does not hand anon its write privileges back', () => {
    // The rollback restores the old trigger, not the old hole: no anon policy
    // ever used those grants, and giving them back would re-open the only way
    // a holder of the public anon key could spend purchase order numbers.
    expect(down).not.toMatch(/grant[^;]*on public\.purchase_orders[^;]*to anon/i)
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
