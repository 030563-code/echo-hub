/**
 * load-material-orders.ts: record raw materials s.r.o. has ordered and not yet
 * received, so the materials board shows them as "on order".
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/stock/load-material-orders.ts --file material-orders.csv --warehouse EB-SRO   # dry run
 *   ... --apply                                                                                                        # writes
 *
 * CSV: component_code,quantity,unit,expected_at,supplier,note. A header row is
 * fine. See scripts/stock/templates/material-orders.csv. Codes must exist in
 * mrp_bom_map (the supplied-components recipe) and must not be a charge line.
 *
 * Not a ledger. Rows land in material_orders; when the goods arrive, the next
 * count (or, later, a receipt movement) takes over and the row gets
 * received_at. Re-running the same file inserts the same rows again, so run it
 * once per sheet: the dry run prints exactly what would be added.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { SUPPLIED_CHARGE_CODES } from '../../src/lib/mrp/supplied-materials'

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

const HEADER = ['component_code', 'quantity', 'unit', 'expected_at', 'supplier', 'note']

interface OrderRow {
  component_code: string
  quantity: number
  unit: string | null
  expected_at: string | null
  supplier: string | null
  note: string | null
}

function parse(text: string): { rows: OrderRow[]; errors: string[] } {
  const errors: string[] = []
  const rows: OrderRow[] = []
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = (lines[0] ?? '').split(',').map((h) => h.trim())
  if (head.join(',') !== HEADER.join(',')) {
    errors.push(`Header must be exactly: ${HEADER.join(',')}`)
    return { rows, errors }
  }
  lines.slice(1).forEach((raw, i) => {
    const lineNo = i + 2
    const cells = raw.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row = Object.fromEntries(HEADER.map((h, j) => [h, cells[j] ?? ''])) as Record<string, string>
    const qty = Number(row.quantity)
    if (!row.component_code) return errors.push(`line ${lineNo}: component_code is blank`) && undefined
    if (!(qty > 0)) return errors.push(`line ${lineNo}: quantity "${row.quantity}" is not a positive number`) && undefined
    if (row.expected_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.expected_at)) {
      return errors.push(`line ${lineNo}: expected_at "${row.expected_at}" is not YYYY-MM-DD`) && undefined
    }
    rows.push({
      component_code: row.component_code.toUpperCase(),
      quantity: qty,
      unit: row.unit || null,
      expected_at: row.expected_at || null,
      supplier: row.supplier || null,
      note: row.note || null,
    })
  })
  return { rows, errors }
}

async function main() {
  const file = arg('file')
  const warehouse = arg('warehouse') ?? 'EB-SRO'
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

  const { rows, errors } = parse(readFileSync(file, 'utf8'))
  const { data: bom } = await admin.from('mrp_bom_map').select('component_code')
  const known = new Set((bom ?? []).map((r) => String(r.component_code).toUpperCase()))
  for (const r of rows) {
    if (SUPPLIED_CHARGE_CODES.has(r.component_code)) errors.push(`${r.component_code} is a charge line, not a material`)
    else if (!known.has(r.component_code)) errors.push(`${r.component_code} is not in the supplied-components recipe (mrp_bom_map)`)
  }
  if (errors.length > 0) {
    console.error('Problems, nothing loaded:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'}: ${rows.length} open order line${rows.length === 1 ? '' : 's'} at ${warehouse}`)
  for (const r of rows) {
    console.log(`  ${r.component_code.padEnd(14)} ${String(r.quantity).padStart(9)} ${(r.unit ?? '').padEnd(4)} expected ${r.expected_at ?? '(unknown)'}  ${r.supplier ?? ''} ${r.note ?? ''}`.trimEnd())
  }
  if (!apply) {
    console.log('Dry run. Add --apply to load.')
    return
  }
  const { data, error } = await admin
    .from('material_orders')
    .insert(rows.map((r) => ({ ...r, warehouse_code: warehouse })))
    .select('id')
  if (error) {
    console.error(`FAILED: ${error.message}`)
    process.exit(1)
  }
  console.log(`inserted ${data?.length ?? 0} row${(data?.length ?? 0) === 1 ? '' : 's'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
