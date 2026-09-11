/**
 * load-finished-count.ts: record a physical count of finished goods from a CSV.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/stock/load-finished-count.ts \
 *     --file counts-finished.csv --warehouse EB-SRO --counted-by "Juraj"            # dry run
 *   npx tsx --env-file=.env.local scripts/stock/load-finished-count.ts \
 *     --file counts-finished.csv --warehouse EB-SRO --counted-by "Juraj" --apply    # writes
 *
 * CSV: sku,quantity[,product_name]. A header row is fine. See
 * scripts/stock/templates/counts-finished.csv.
 *
 * Dry run by default: parses, shows every row against the current level, and
 * writes nothing. --apply records the count through hub_record_stock_count
 * with ONE batch id for the run, so re-running the same file with --apply
 * applies nothing twice (and still stamps the count date).
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parseCountInput } from '../../src/lib/stock/count-parse'
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

async function main() {
  const file = arg('file')
  const warehouse = arg('warehouse') ?? 'EB-SRO'
  const countedBy = arg('counted-by') ?? 'unnamed'
  const countedAt = arg('counted-at') ?? new Date().toISOString().slice(0, 10)
  const apply = process.argv.includes('--apply')
  if (!file) {
    console.error('--file is required')
    process.exit(1)
  }
  if (!(STOCK_WAREHOUSES as readonly string[]).includes(warehouse)) {
    console.error(`--warehouse must be one of ${STOCK_WAREHOUSES.join(', ')}`)
    process.exit(1)
  }

  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  assertProject(url, 'korylyniwsqtsvzuzydg')
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Third column, product_name, is optional and ours to carry.
  const text = readFileSync(file, 'utf8')
  const names = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, ''))
    if (parts.length >= 3 && parts[0] && parts[2]) names.set(parts[0].toUpperCase(), parts[2])
  }
  const { rows, errors } = parseCountInput(text)
  if (errors.length > 0) {
    console.error('Parse errors, nothing recorded:')
    for (const e of errors) console.error(`  line ${e.line}: ${e.message}`)
    process.exit(1)
  }
  if (rows.some((r) => !Number.isInteger(r.counted))) {
    console.error('Finished goods are counted in whole units; a row has a fraction.')
    process.exit(1)
  }

  const { data: current } = await admin
    .from('warehouse_stock_levels')
    .select('sku, quantity_on_hand, last_counted_at')
    .eq('warehouse_code', warehouse)
    .in('sku', rows.map((r) => r.sku))
  const before = new Map((current ?? []).map((c) => [String(c.sku), Number(c.quantity_on_hand)]))

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'}: ${rows.length} SKUs at ${warehouse}, counted by ${countedBy} on ${countedAt}`)
  for (const r of rows) {
    const was = before.get(r.sku)
    console.log(`  ${r.sku.padEnd(14)} ${String(was ?? '(new)').padStart(7)} -> ${String(r.counted).padStart(7)}${names.has(r.sku) ? `   ${names.get(r.sku)}` : ''}`)
  }
  if (!apply) {
    console.log('Dry run. Add --apply to record.')
    return
  }

  const batchId = randomUUID()
  const { data, error } = await admin.rpc('hub_record_stock_count', {
    p_item_kind: 'finished',
    p_warehouse: warehouse,
    p_rows: rows.map((r) => ({ sku: r.sku, counted: r.counted, product_name: names.get(r.sku) ?? null })),
    p_batch_id: batchId,
    p_uid: null,
    p_note: `Physical count ${countedAt} by ${countedBy} (warm start)`,
  })
  if (error) {
    console.error('hub_record_stock_count failed:', error.message)
    process.exit(1)
  }
  const out = (data ?? []) as Array<{ sku: string; before: number; counted: number; delta: number; applied: boolean }>
  console.log(`batch ${batchId}`)
  for (const o of out) console.log(`  ${o.sku.padEnd(14)} ${String(o.before).padStart(7)} -> ${String(o.counted).padStart(7)}  delta ${o.delta}  ${o.applied ? 'applied' : 'unchanged'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
