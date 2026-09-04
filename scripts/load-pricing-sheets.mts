/**
 * Load the Google Sheet price lists into list_prices and contract_prices.
 *
 * Run with Node's native type stripping, no extra dependency:
 *
 *   node scripts/load-pricing-sheets.ts            # dry run, writes nothing
 *   node scripts/load-pricing-sheets.ts --commit   # writes
 *
 * DRY RUN IS THE DEFAULT AND IT REFUSES TO COMMIT WHILE ANY ROW IS UNMAPPED.
 * These prices are what the quote builder charges a customer, so a part number
 * nobody has mapped stops the load rather than being skipped quietly. Pass
 * --skip-unmapped once you have read the list and accepted it.
 *
 * Re-runnable. Every write is an upsert on the table's natural key, so a second
 * run against an edited sheet updates rather than duplicates, and each write is
 * recorded in pricing_change_log exactly like a hand edit in the Hub.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolveSheetSku, type SheetRegion } from '../src/lib/pricing/sheet-crosswalk.ts'

const SHEET_ID = '1c6ASm4_g3K6XEGRJ_7_lhXc5CP6sHb533Am7TF4wewc'

const COMMIT = process.argv.includes('--commit')
const SKIP_UNMAPPED = process.argv.includes('--skip-unmapped')

/**
 * ZnD is a DISTRIBUTOR with its own net prices, not the general list. Its H9
 * nets 180 where the general list nets 185, and list_prices is unique on
 * (sku, currency), so loading it as a list price would collide with the
 * General US rows on every shared SKU.
 *
 * It therefore loads as a contract price and needs a HubSpot company. HubSpot
 * holds THREE candidates and none is in account_registry, so this is not
 * something to guess:
 *
 *   610794307    ZND (UK) LIMITED   znduk.com   (UK, almost certainly wrong)
 *   2503150855   ZND               znd.com
 *   56468453991  ZnD               no domain
 *
 * Pass --znd-company=<id> once Dean has confirmed which. Without it ZnD is
 * skipped and reported.
 */
const ZND_COMPANY = (process.argv.find((a) => a.startsWith('--znd-company='))?.split('=')[1] ?? '').trim()

/** Read the service-role key from .env.local without pulling in dotenv. */
function env(name: string): string {
  const fromProcess = process.env[name]
  if (fromProcess) return fromProcess
  const file = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`))
  if (!line) throw new Error(`${name} is not set and is not in .env.local`)
  return line.slice(name.length + 1).trim()
}

const supabase = createClient(
  env('NEXT_PUBLIC_SUPABASE_URL'),
  env('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } },
)

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal RFC4180 reader. The sheets quote any cell containing a comma, which
 *  every description does, so a naive split on comma corrupts most rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  row.push(cell)
  rows.push(row)
  return rows
}

async function fetchTab(gid: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`gid ${gid}: HTTP ${res.status}`)
  return parseCsv(await res.text())
}

/** "$1,297.13" and " $ 555.00 " both appear. Blank and "-" mean no price. */
function money(raw: string): number | null {
  const cleaned = String(raw ?? '').replace(/[^0-9.]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * SKU to the product's name and id in HubSpot.
 *
 * The name shown in the Hub has to be the one a rep already reads in HubSpot,
 * Dean's call: the pricing screens are not the place to invent a second set of
 * product names. Taken from HubSpot rather than from the sheet descriptions,
 * which differ per contractor and would put a different name on the same SKU
 * depending on which sheet happened to load last.
 */
async function hubspotProductsBySku(): Promise<Map<string, { name: string; id: string }>> {
  const token = env('HUBSPOT_ACCESS_TOKEN')
  const out = new Map<string, { name: string; id: string }>()
  let after: string | undefined
  do {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/products')
    url.searchParams.set('limit', '100')
    url.searchParams.set('properties', 'name,hs_sku')
    if (after) url.searchParams.set('after', after)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`HubSpot products: HTTP ${res.status}`)
    const body = (await res.json()) as {
      results: { id: string; properties: { name?: string; hs_sku?: string } }[]
      paging?: { next?: { after?: string } }
    }
    for (const p of body.results) {
      const sku = (p.properties.hs_sku ?? '').trim()
      const name = (p.properties.name ?? '').trim()
      // First one wins. A SKU appearing twice in HubSpot is a duplicate product,
      // not two products, and taking the later one would flip the name at random.
      if (sku && name && !out.has(sku)) out.set(sku, { name, id: p.id })
    }
    after = body.paging?.next?.after
  } while (after)
  return out
}

// ---------------------------------------------------------------------------
// What we collect
// ---------------------------------------------------------------------------

interface ListRow {
  sku: string
  currency: string
  unit_price: number
  map_price: number | null
  floor_price: number | null
  source: string
}
interface ContractRow {
  hubspot_company_id: string
  sku: string
  currency: string
  unit_price: number
  customer_part_number: string
  source: string
}

const listRows: ListRow[] = []
const contractRows: ContractRow[] = []
const unmapped: { source: string; part: string; reason: string }[] = []

function mapPart(part: string, region: SheetRegion, source: string): string | null {
  const r = resolveSheetSku(part, region)
  if (r.ok) return r.sku
  unmapped.push({ source, part, reason: r.reason })
  return null
}

/**
 * The general lists share one shape: a leading blank column, then PART #,
 * Description, blank, Distributor Net, MAP, MSRP.
 *
 * Dean's tiering: unit_price is MSRP because the rep quotes from it and
 * discounts down, floor_price is Distributor Net because that is the limit,
 * and map_price is carried for reference only.
 */
function readGeneralList(rows: string[][], currency: string, region: SheetRegion, source: string) {
  for (const r of rows) {
    const part = (r[1] ?? '').trim()
    if (part === '' || part.toUpperCase() === 'PART #') continue
    const net = money(r[4] ?? '')
    const map = money(r[5] ?? '')
    const msrp = money(r[6] ?? '')
    // A section heading ("Barriers", "Accessories") has a part-shaped cell and
    // no prices, which is how it is told apart from a product.
    if (net === null && map === null && msrp === null) continue
    const sku = mapPart(part, region, source)
    if (!sku) continue
    // MSRP is the quote default; fall back to net for a row that only carries
    // one figure rather than dropping the product.
    const unit = msrp ?? map ?? net
    if (unit === null) continue
    listRows.push({ sku, currency, unit_price: unit, map_price: map, floor_price: net, source })
  }
}

/** Contractor sheets: PARTNUMBER first, price column varies, so it is named. */
function readContractorBlock(
  rows: string[][],
  opts: { companyId: string; currency: string; region: SheetRegion; partCol: number; priceCol: number; source: string; from: number; to: number },
) {
  for (let i = opts.from; i < opts.to && i < rows.length; i++) {
    const r = rows[i]
    const part = (r[opts.partCol] ?? '').trim()
    if (part === '' || part.toUpperCase() === 'PARTNUMBER') continue
    const price = money(r[opts.priceCol] ?? '')
    if (price === null) continue
    const sku = mapPart(part, opts.region, opts.source)
    if (!sku) continue
    contractRows.push({
      hubspot_company_id: opts.companyId,
      sku,
      currency: opts.currency,
      unit_price: price,
      customer_part_number: part,
      source: opts.source,
    })
  }
}

/** Find the row index where a contractor sheet's second block starts. */
function blockStart(rows: string[][], marker: string): number {
  const i = rows.findIndex((r) => r.some((c) => c.trim().toUpperCase().startsWith(marker)))
  return i === -1 ? rows.length : i
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(COMMIT ? 'COMMIT MODE: this will write.\n' : 'DRY RUN: nothing will be written.\n')

  const [usList, caList, united, herc, hermeq, znd, sunbelt] = await Promise.all(
    ['1498346230', '84297186', '1853416371', '1768099883', '72203385', '906388794', '1944830202'].map(fetchTab),
  )

  readGeneralList(usList, 'USD', 'US', 'General US')
  readGeneralList(caList, 'CAD', 'CA', 'General Canada')

  // Confirmed against account_registry on 2026-09-04. The Canada codes for
  // United Rentals and Herc are null in Xero, which is a warning surfaced in
  // the Hub, not a reason to withhold the price.
  const UNITED = '45934040176'   // United Rentals Inc,  Xero UNIUSA001
  const HERC = '39480298534'     // Herc Rentals LLC,    Xero HERUSA001
  const HERMEQ = '46273165992'   // Hermeq LLC,          Xero HERUSA002

  const unitedCa = blockStart(united, 'UNITED RENTALS CANADA')
  // United Rentals lists 2025 Net in column 3 and 2026 Net in column 8. Only
  // 2026 is loaded; valid_from exists for when a 2027 sheet arrives.
  readContractorBlock(united, { companyId: UNITED, currency: 'USD', region: 'US', partCol: 0, priceCol: 8, source: 'United Rentals USA', from: 0, to: unitedCa })
  readContractorBlock(united, { companyId: UNITED, currency: 'CAD', region: 'CA', partCol: 0, priceCol: 8, source: 'United Rentals Canada', from: unitedCa, to: united.length })

  const hercCa = blockStart(herc, 'HERC CANADA')
  readContractorBlock(herc, { companyId: HERC, currency: 'USD', region: 'US', partCol: 0, priceCol: 3, source: 'Herc USA', from: 0, to: hercCa })
  readContractorBlock(herc, { companyId: HERC, currency: 'CAD', region: 'CA', partCol: 0, priceCol: 3, source: 'Herc Canada', from: hercCa, to: herc.length })

  readContractorBlock(hermeq, { companyId: HERMEQ, currency: 'USD', region: 'US', partCol: 0, priceCol: 5, source: 'HERMEQ', from: 0, to: hermeq.length })

  // ZnD's own distributor net, which is the column that differs from the
  // general list. Its sheet shares the general layout, so the part number is in
  // column 1 and net in column 4.
  if (ZND_COMPANY) {
    readContractorBlock(znd, { companyId: ZND_COMPANY, currency: 'USD', region: 'US', partCol: 1, priceCol: 4, source: 'ZnD', from: 0, to: znd.length })
  } else {
    console.log('SKIPPING ZnD: no --znd-company=<id> given. HubSpot holds three candidates')
    console.log('  (610794307 ZND UK, 2503150855 znd.com, 56468453991 ZnD) and none is in')
    console.log('  account_registry, so the right one has to be confirmed rather than guessed.\n')
  }

  // SunBelt and White Cap share one tab at the same prices but are separate
  // HubSpot companies, so the block is loaded once per company.
  const SUNBELT = '599587900'    // Sunbelt Rentals Of Canada Inc, Xero SUNUS01
  const WHITECAP = '5059277213'  // White Cap Construction Supply, Xero WHIUSA001
  for (const [id, label] of [[SUNBELT, 'SunBelt'], [WHITECAP, 'White Cap']] as const) {
    readContractorBlock(sunbelt, { companyId: id, currency: 'USD', region: 'US', partCol: 0, priceCol: 3, source: label, from: 0, to: sunbelt.length })
  }

  // A duplicate (sku, currency) means two sheets claim the same list price at
  // different figures. Postgres would refuse the upsert anyway ("cannot affect
  // row a second time"), but the useful moment to catch it is here, naming both
  // sources, rather than as a constraint error halfway through a write.
  const listSeen = new Map<string, ListRow>()
  const listClashes: string[] = []
  for (const r of listRows) {
    const k = `${r.sku}/${r.currency}`
    const prev = listSeen.get(k)
    if (prev && prev.unit_price !== r.unit_price) {
      listClashes.push(`${k}: ${prev.source} says ${prev.unit_price}, ${r.source} says ${r.unit_price}`)
    } else if (!prev) listSeen.set(k, r)
  }
  // Same rule as the list side: a repeat only matters when the two rows
  // disagree. HERMEQ's sheet lists the H9X twice at the same $245, which is
  // sheet noise rather than a conflict, so it is de-duplicated silently and
  // only a genuine disagreement stops the load.
  const contractSeen = new Map<string, ContractRow>()
  const contractClashes: string[] = []
  for (const r of contractRows) {
    const k = `${r.hubspot_company_id}/${r.sku}/${r.currency}`
    const prev = contractSeen.get(k)
    if (prev && prev.unit_price !== r.unit_price) {
      contractClashes.push(`${k}: ${prev.source} says ${prev.unit_price}, ${r.source} says ${r.unit_price}`)
    } else if (!prev) contractSeen.set(k, r)
  }

  // --- report ---
  console.log(`list_prices rows     : ${listRows.length}`)
  console.log(`contract_prices rows : ${contractRows.length}`)
  console.log(`unmapped rows        : ${unmapped.length}\n`)

  if (unmapped.length > 0) {
    console.log('UNMAPPED, nothing will be priced for these:')
    const seen = new Set<string>()
    for (const u of unmapped) {
      const k = `${u.source}|${u.part}`
      if (seen.has(k)) continue
      seen.add(k)
      console.log(`  [${u.source}] ${u.part}\n      ${u.reason}`)
    }
    console.log()
  }

  console.log('list_prices preview (sku, currency, MSRP / MAP / net):')
  for (const r of listRows) {
    console.log(`  ${r.sku.padEnd(12)} ${r.currency}  ${String(r.unit_price).padStart(9)} / ${String(r.map_price ?? '-').padStart(9)} / ${String(r.floor_price ?? '-').padStart(9)}   ${r.source}`)
  }
  console.log('\ncontract_prices preview (company, sku, currency, price, their code):')
  for (const r of contractRows) {
    console.log(`  ${r.source.padEnd(22)} ${r.sku.padEnd(12)} ${r.currency} ${String(r.unit_price).padStart(9)}   ${r.customer_part_number}`)
  }

  if (listClashes.length > 0 || contractClashes.length > 0) {
    console.error('\nKEY CLASHES, these would overwrite each other:')
    for (const c of [...listClashes, ...contractClashes]) console.error(`  ${c}`)
  }

  if (!COMMIT) {
    console.log('\nDry run finished. Re-run with --commit to write.')
    return
  }
  if (listClashes.length > 0 || contractClashes.length > 0) {
    console.error('\nREFUSING TO COMMIT: two sources disagree on the same key. Nothing was written.')
    process.exitCode = 1
    return
  }
  if (unmapped.length > 0 && !SKIP_UNMAPPED) {
    console.error('\nREFUSING TO COMMIT: unmapped rows above. Fix the crosswalk, or pass --skip-unmapped once you have read the list.')
    process.exitCode = 1
    return
  }

  // Contractors must exist before their prices: saveContractPrice enforces the
  // same rule in the Hub, and a price on an unknown contractor resolves for no
  // deal.
  const companies = [...new Set(contractRows.map((r) => r.hubspot_company_id))]
  const names: Record<string, string> = {
    [UNITED]: 'United Rentals Inc', [HERC]: 'Herc Rentals LLC', [HERMEQ]: 'Hermeq LLC',
    [SUNBELT]: 'Sunbelt Rentals Of Canada Inc', [WHITECAP]: 'White Cap Construction Supply',
    ...(ZND_COMPANY ? { [ZND_COMPANY]: 'ZnD' } : {}),
  }
  const stamp = `sheet import ${new Date().toISOString().slice(0, 10)}`

  for (const id of companies) {
    const { error } = await supabase.from('contractors').upsert(
      { hubspot_company_id: id, name: names[id] ?? id, is_active: true, updated_by_label: stamp, updated_at: new Date().toISOString() },
      { onConflict: 'hubspot_company_id' },
    )
    if (error) throw new Error(`contractors ${id}: ${error.message}`)
  }
  console.log(`\ncontractors upserted: ${companies.length}`)

  // The product name and HubSpot id, so the pricing screens read as product
  // names rather than bare SKUs. Missing from the first load, which left every
  // row showing only its SKU.
  const products = await hubspotProductsBySku()
  const namesMissing = [...new Set([...listSeen.values()].map((r) => r.sku))].filter((sku) => !products.has(sku))
  if (namesMissing.length > 0) {
    console.log(`\nno HubSpot product name for: ${namesMissing.join(', ')}`)
  }

  const listPayload = [...listSeen.values()].map((r) => ({
    sku: r.sku, currency: r.currency, unit_price: r.unit_price,
    map_price: r.map_price, floor_price: r.floor_price,
    product_name: products.get(r.sku)?.name ?? null,
    hs_product_id: products.get(r.sku)?.id ?? null,
    is_active: true, updated_by_label: stamp, updated_at: new Date().toISOString(),
  }))
  const { error: le } = await supabase.from('list_prices').upsert(listPayload, { onConflict: 'sku,currency' })
  if (le) throw new Error(`list_prices: ${le.message}`)
  console.log(`list_prices upserted: ${listPayload.length}`)

  const contractPayload = [...contractSeen.values()].map((r) => ({
    hubspot_company_id: r.hubspot_company_id, sku: r.sku, currency: r.currency,
    unit_price: r.unit_price, customer_part_number: r.customer_part_number,
    valid_from: null, is_active: true, updated_by_label: stamp, updated_at: new Date().toISOString(),
  }))
  const { error: ce } = await supabase.from('contract_prices').upsert(contractPayload, { onConflict: 'hubspot_company_id,sku,currency,valid_from' })
  if (ce) throw new Error(`contract_prices: ${ce.message}`)
  console.log(`contract_prices upserted: ${contractPayload.length}`)

  await supabase.from('pricing_change_log').insert({
    table_name: 'list_prices', row_key: stamp,
    before: null, after: { list_prices: listPayload.length, contract_prices: contractPayload.length },
    changed_by_label: stamp,
  })
  console.log('\nDone.')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
