/**
 * load-in-flight-orders.ts: load the manufacturing orders already in flight at
 * s.r.o. as full Hub chains, from a CSV.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/stock/load-in-flight-orders.ts --file in-flight-orders.csv           # dry run
 *   npx tsx --env-file=.env.local scripts/stock/load-in-flight-orders.ts --file in-flight-orders.csv --apply   # writes
 *
 * CSV, one row per order LINE; rows sharing chain_key make one order:
 *   chain_key,depot,sku,product_name,quantity,depot_po_number,sro_po_number,
 *   bamida_po_number,stage,sent_at,est_start,est_finish,finished_at,note
 * stage: sent | in_production | finished | ready_stock
 *
 * Each chain is one call to hub_warm_start_po_chain, which inserts every leg
 * at its final status (so no webhook fires) and refuses any PO number that
 * already exists rather than overwriting it. Dry run by default.
 *
 * Before running with --apply: switch off the old n8n "PO Phase 1" Xero poll,
 * so it cannot insert its own rows beside the loaded chains.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { STOCK_WAREHOUSES } from '../../src/lib/stock/warehouses'

function env(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing env var ${name}`)
    process.exit(1)
  }
  return v
}

function assertProject(url: string, expected: string) {
  const host = new URL(url).host
  if (host !== `${expected}.supabase.co` && process.env.ALLOW_PROJECT_MISMATCH !== '1') {
    console.error(`Refusing to run against ${host} (expected ${expected}.supabase.co)`)
    process.exit(1)
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const STAGES = new Set(['sent', 'in_production', 'finished', 'ready_stock'])
const HEADER = [
  'chain_key', 'depot', 'sku', 'product_name', 'quantity', 'depot_po_number',
  'sro_po_number', 'bamida_po_number', 'stage', 'sent_at', 'est_start', 'est_finish', 'finished_at', 'note',
]

interface Chain {
  key: string
  depot: string
  stage: string
  note: string
  depot_po_number: string
  sro_po_number: string
  bamida_po_number: string
  sent_at: string
  est_start: string
  est_finish: string
  finished_at: string
  lines: { sku: string; product_name: string; quantity: number }[]
}

function parse(text: string): { chains: Chain[]; errors: string[] } {
  const errors: string[] = []
  const chains = new Map<string, Chain>()
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = (lines[0] ?? '').split(',').map((h) => h.trim())
  if (head.join(',') !== HEADER.join(',')) {
    errors.push(`Header must be exactly: ${HEADER.join(',')}`)
    return { chains: [], errors }
  }
  lines.slice(1).forEach((raw, i) => {
    const lineNo = i + 2
    const cells = raw.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row = Object.fromEntries(HEADER.map((h, j) => [h, cells[j] ?? ''])) as Record<string, string>
    if (!row.chain_key) return errors.push(`line ${lineNo}: chain_key is blank`) && undefined
    if (!(STOCK_WAREHOUSES as readonly string[]).includes(row.depot)) {
      errors.push(`line ${lineNo}: depot "${row.depot}" is not one of ${STOCK_WAREHOUSES.join(', ')}`)
      return
    }
    if (!STAGES.has(row.stage)) return errors.push(`line ${lineNo}: stage "${row.stage}" is not sent, in_production, finished or ready_stock`) && undefined
    const qty = Number(row.quantity)
    if (!Number.isInteger(qty) || qty <= 0) return errors.push(`line ${lineNo}: quantity "${row.quantity}" is not a whole positive number`) && undefined
    if (!row.sku) return errors.push(`line ${lineNo}: sku is blank`) && undefined

    const existing = chains.get(row.chain_key)
    if (existing) {
      for (const k of ['depot', 'stage', 'depot_po_number', 'sro_po_number', 'bamida_po_number'] as const) {
        if (existing[k] !== row[k]) errors.push(`line ${lineNo}: ${k} differs from an earlier line of chain ${row.chain_key}`)
      }
      existing.lines.push({ sku: row.sku.toUpperCase(), product_name: row.product_name, quantity: qty })
      return
    }
    chains.set(row.chain_key, {
      key: row.chain_key,
      depot: row.depot,
      stage: row.stage,
      note: row.note,
      depot_po_number: row.depot_po_number,
      sro_po_number: row.sro_po_number,
      bamida_po_number: row.bamida_po_number,
      sent_at: row.sent_at,
      est_start: row.est_start,
      est_finish: row.est_finish,
      finished_at: row.finished_at,
      lines: [{ sku: row.sku.toUpperCase(), product_name: row.product_name, quantity: qty }],
    })
  })
  return { chains: [...chains.values()], errors }
}

async function main() {
  const file = arg('file')
  const apply = process.argv.includes('--apply')
  if (!file) {
    console.error('--file is required')
    process.exit(1)
  }
  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  assertProject(url, 'korylyniwsqtsvzuzydg')
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { chains, errors } = parse(readFileSync(file, 'utf8'))
  if (errors.length > 0) {
    console.error('Problems, nothing loaded:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'}: ${chains.length} chain${chains.length === 1 ? '' : 's'}`)
  for (const c of chains) {
    const units = c.lines.reduce((s, l) => s + l.quantity, 0)
    console.log(`  ${c.key.padEnd(12)} ${c.depot}  ${c.stage.padEnd(13)} ${units} units in ${c.lines.length} line${c.lines.length === 1 ? '' : 's'}` +
      `  depot ${c.depot_po_number || '(mint)'}  sro ${c.sro_po_number || '(mint)'}  bamida ${c.stage === 'ready_stock' ? 'n/a' : c.bamida_po_number || '(mint)'}`)
  }
  if (!apply) {
    console.log('Dry run. Add --apply to load.')
    return
  }

  let ok = 0
  for (const c of chains) {
    const { data, error } = await admin.rpc('hub_warm_start_po_chain', {
      p: {
        depot: c.depot,
        stage: c.stage,
        note: c.note,
        lines: c.lines,
        depot_po_number: c.depot_po_number || null,
        sro_po_number: c.sro_po_number || null,
        bamida_po_number: c.bamida_po_number || null,
        sent_at: c.sent_at || null,
        est_start: c.est_start || null,
        est_finish: c.est_finish || null,
        finished_at: c.finished_at || null,
      },
    })
    if (error) {
      console.error(`  ${c.key}: FAILED ${error.message}`)
      continue
    }
    const out = data as { ok: boolean; reason?: string; po_number?: string; depot_po?: string; sro_po?: string; bamida_po?: string | null; master_ref?: string }
    if (!out.ok) {
      console.error(`  ${c.key}: skipped, ${out.reason} (${out.po_number})`)
      continue
    }
    ok += 1
    console.log(`  ${c.key}: ${out.master_ref}  depot ${out.depot_po}  sro ${out.sro_po}  bamida ${out.bamida_po ?? 'n/a'}`)
  }
  console.log(`loaded ${ok} of ${chains.length}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
