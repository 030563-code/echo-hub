import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PAGE_KEY_MAX,
  PAGE_STATE_MAX_BYTES,
  isPageKey,
  isStale,
  pageStateBytes,
  parsePageState,
} from '@/lib/page-state'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260907120000_user_page_state.sql'),
  'utf8',
)

describe('page keys', () => {
  it('accepts every key the Hub actually uses', () => {
    for (const key of [
      'quote-builder:12345',
      'quote-builder:12345:edit:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      'quotes:filters',
      'deal-wizard',
      'raise-po',
      'transport:add-shipment',
      'invoice-editor:12345',
      'commercial-invoice:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      'bom',
      'bom:material-prices',
      'po-board',
      'po-board:table',
      'po-approvals',
      'mrp-board',
      'warehouse-stock',
      'commercial-invoices',
    ]) {
      expect(isPageKey(key), key).toBe(true)
    }
  })

  it('refuses anything that is not one', () => {
    for (const key of [
      '',
      'Quote-Builder:1',
      '1bad:key',
      'trailing:',
      ':leading',
      'has space:x',
      'drop table;--',
      'quote/builder',
      'a'.repeat(PAGE_KEY_MAX + 1),
      42,
      null,
      undefined,
    ]) {
      expect(isPageKey(key as unknown), String(key)).toBe(false)
    }
  })

  it('checks length before the pattern, so a huge string cannot be walked', () => {
    // Every character is legal, so only the length cap rejects this.
    expect(isPageKey('a'.repeat(PAGE_KEY_MAX))).toBe(true)
    expect(isPageKey('a'.repeat(PAGE_KEY_MAX + 1))).toBe(false)
  })
})

describe('the database agrees with the app', () => {
  // The rule lives in three places: this module, the CHECK constraint, and the
  // browser. Two of them are text, so they get asserted equal rather than
  // trusted to stay equal.
  it('the CHECK constraint uses exactly this pattern', () => {
    expect(MIGRATION).toContain("page_key ~ '^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)*$'")
  })

  it('the CHECK constraint uses exactly this length cap', () => {
    expect(MIGRATION).toContain(`length(page_key) <= ${PAGE_KEY_MAX}`)
  })

  it('the CHECK constraint uses exactly this size cap', () => {
    expect(MIGRATION).toContain(`octet_length(state::text) <= ${PAGE_STATE_MAX_BYTES}`)
  })

  it('keeps the table owner-only and out of anon reach', () => {
    expect(MIGRATION).toContain('enable row level security')
    expect(MIGRATION).toContain('revoke all on public.user_page_state from public, anon')
    expect(MIGRATION).toContain('user_id = (select auth.uid())')
    // RLS does not restrain TRUNCATE, and this project grants it by default.
    expect(MIGRATION).toContain('revoke truncate, trigger, references on public.user_page_state from authenticated')
  })
})

describe('payload size', () => {
  it('measures the bytes that will actually be stored', () => {
    expect(pageStateBytes({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    // Multi-byte characters count as bytes, not as characters, because that is
    // what octet_length does at the other end.
    expect(pageStateBytes({ a: '€' })).toBeGreaterThan(JSON.stringify({ a: '€' }).length)
  })
})

describe('parsePageState', () => {
  const parse = (raw: unknown) => (typeof raw === 'number' ? raw : null)

  it('returns null rather than throwing on anything unreadable', () => {
    expect(parsePageState('nonsense', parse)).toBeNull()
    expect(parsePageState(null, parse)).toBeNull()
    expect(
      parsePageState(1, () => {
        throw new Error('boom')
      }),
    ).toBeNull()
  })

  it('passes a good value through', () => {
    expect(parsePageState(7, parse)).toBe(7)
  })
})

describe('isStale', () => {
  it('is only true when both sides have a fingerprint and they differ', () => {
    expect(isStale('a', 'b')).toBe(true)
    expect(isStale('a', 'a')).toBe(false)
    // A page with nothing underneath it to go stale against is never stale.
    expect(isStale(null, 'b')).toBe(false)
    expect(isStale('a', null)).toBe(false)
    expect(isStale(null, null)).toBe(false)
  })
})
