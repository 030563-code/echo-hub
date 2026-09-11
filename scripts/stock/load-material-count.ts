/**
 * load-material-count.ts: record a physical count of s.r.o.-owned raw
 * materials from a CSV.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/stock/load-material-count.ts \
 *     --file counts-materials.csv --warehouse EB-SRO --counted-by "Juraj"           # dry run
 *   ... --apply                                                                     # writes
 *
 * CSV: component_code,quantity,unit,description. A header row is fine. See
 * scripts/stock/templates/counts-materials.csv. Codes must exist in
 * mrp_bom_map (the supplied-components recipe) and must not be a charge line;
 * anything else is refused with a message, so a typo cannot create a phantom
 * material.
 *
 * Dry run by default. --apply records through hub_record_stock_count with one
 * batch id per run; re-running the same file applies nothing twice.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parseCountInput } from '../../src/lib/stock/count-parse'
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

  const url = env('NEXT_PUBLIC_SUPABASE_URL')
  assertProject(url, 'korylyniwsqtsvzuzydg')
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const text = readFileSync(file, 'utf8')
  const extras = new Map<string, { unit: string | null; description: string | null }>()
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, ''))
    if (parts[0]) extras.set(parts[0].toUpperCase(), { unit: parts[2] || null, description: parts[3] || null })
  }
  const { rows, errors } = parseCountInput(text)
  if (errors.length > 0) {
    console.error('Parse errors, nothing recorded:')
    for (const e of errors) console.error(`  line ${e.line}: ${e.message}`)
    process.exit(1)
  }

  // Only codes the recipe knows, and never a charge line.
  const { data: bom } = await admin.from('mrp_bom_map').select('component_code, component_desc')
  const known = new Map((bom ?? []).map((b) => [String(b.component_code).toUpperCase(), String(b.component_desc ?? '')]))
  const refused = rows.filter((r) => !known.has(r.sku) || SUPPLIED_CHARGE_CODES.has(r.sku))
  if (refused.length > 0) {
    console.error('Refused, not in the supplied-components recipe (or a charge line):')
    for (const r of refused) console.error(`  ${r.sku}`)
    console.error(`Known stock codes: ${[...known.keys()].filter((c) => !SUPPLIED_CHARGE_CODES.has(c)).sort().join(', ')}`)
    process.exit(1)
  }

  const { data: current } = await admin
    .from('material_stock_levels')
    .select('component_code, quantity')
    .eq('warehouse_code', warehouse)
    .in('component_code', rows.map((r) => r.sku))
  const before = new Map((current ?? []).map((c) => [String(c.component_code), Number(c.quantity)]))

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'}: ${rows.length} components at ${warehouse}, counted by ${countedBy} on ${countedAt}`)
  for (const r of rows) {
    const x = extras.get(r.sku)
    console.log(`  ${r.sku.padEnd(16)} ${String(before.get(r.sku) ?? '(new)').padStart(10)} -> ${String(r.counted).padStart(10)} ${x?.unit ?? ''}  ${x?.description ?? known.get(r.sku) ?? ''}`)
  }
  if (!apply) {
    console.log('Dry run. Add --apply to record.')
    return
  }

  const batchId = randomUUID()
  const { data, error } = await admin.rpc('hub_record_stock_count', {
    p_item_kind: 'material',
    p_warehouse: warehouse,
    p_rows: rows.map((r) => ({
      sku: r.sku,
      counted: r.counted,
      description: extras.get(r.sku)?.description ?? known.get(r.sku) ?? null,
      unit: extras.get(r.sku)?.unit ?? null,
    })),
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
  for (const o of out) console.log(`  ${o.sku.padEnd(16)} ${String(o.before).padStart(10)} -> ${String(o.counted).padStart(10)}  delta ${o.delta}  ${o.applied ? 'applied' : 'unchanged'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
