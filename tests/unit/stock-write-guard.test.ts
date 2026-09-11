import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every change to a stock balance goes through the ledger.
 *
 * warehouse_stock_levels and material_stock_levels are moved by two RPCs and
 * nothing else; src/lib/stock/apply.ts is the only TypeScript allowed to name
 * those RPCs. This walks src/ and fails on any direct write to either table
 * or any rpc() call to either function from anywhere else. Same genre as
 * page-state-guard and email-recipients-guard: a rule that only holds while
 * somebody is looking is not a rule.
 */

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const FILES = walk(SRC)
const readRel = (f: string) => ({ rel: relative(ROOT, f), text: readFileSync(f, 'utf8') })

const TABLE = /from\(\s*["'`](warehouse_stock_levels|material_stock_levels)["'`]\s*\)/
const DIRECT_WRITE =
  /from\(\s*["'`](warehouse_stock_levels|material_stock_levels)["'`]\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/
const LEDGER_RPC = /rpc\(\s*["'`](hub_apply_stock_movements|hub_record_stock_count)["'`]/

describe('stock write guard', () => {
  it('self-check: the walk found the stock readers', () => {
    // A broken matcher must fail loudly, not pass on an empty list.
    expect(FILES.length).toBeGreaterThan(100)
    const readers = FILES.map(readRel).filter(({ text }) => TABLE.test(text))
    expect(readers.length).toBeGreaterThanOrEqual(3)
    const apply = readRel(join(SRC, 'lib/stock/apply.ts')).text
    expect(apply).toContain("rpc('hub_apply_stock_movements'")
    expect(apply).toContain("rpc('hub_record_stock_count'")
  })

  it('no file writes a stock balance table directly', () => {
    const offenders = FILES.map(readRel)
      .filter(({ text }) => DIRECT_WRITE.test(text))
      .map(({ rel }) => rel)
    expect(offenders, `direct stock writes in: ${offenders.join(', ')}`).toEqual([])
  })

  it('only src/lib/stock/apply.ts calls the ledger RPCs', () => {
    const offenders = FILES.map(readRel)
      .filter(({ rel, text }) => LEDGER_RPC.test(text) && rel !== 'src/lib/stock/apply.ts')
      .map(({ rel }) => rel)
    expect(offenders, `ledger RPC called outside apply.ts: ${offenders.join(', ')}`).toEqual([])
  })

  it('nothing calls the retired increment_stock RPC', () => {
    const offenders = FILES.map(readRel)
      .filter(({ text }) => /rpc\(\s*["'`]increment_stock["'`]/.test(text))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })
})
