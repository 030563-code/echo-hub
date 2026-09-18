#!/usr/bin/env node
/**
 * How much a salesperson's own probability is worth.
 *
 * Dean, 18 Sep 2026: "if a person keeps saying 50% 50% 50% for everything
 * because they are lazy but their actual hit rate is 25% it trusts them less."
 *
 * The idea: take every CLOSED deal where the rep stated a probability, add
 * those probabilities up to get the wins they predicted, compare that with the
 * wins they actually got, and carry the ratio forward as a trust factor on
 * everything still open.
 *
 *     expected wins  E = Σ stated_i
 *     actual wins    W = Σ won_i
 *     raw factor     k = W / E
 *
 * Three things stop that simple ratio from lying:
 *
 * 1. SHRINKAGE. Four closed deals cannot tell you someone is half as good as
 *    they think. k is pulled toward 1 by `prior` imaginary perfectly-calibrated
 *    deals: k = (W + m) / (E + m). At m=10 a rep needs a real body of history
 *    before their factor moves far, and it moves smoothly, never in a jump.
 *
 * 2. LEAD TIME. A probability first typed in on the day the deal closed is not
 *    a forecast, it is a record of the outcome, and scoring it flatters
 *    everyone. --min-lead-days drops those. (On the live data today 24 of 71
 *    closed deals were stamped within a day of closing or after it.)
 *
 * 3. RESOLUTION, not just bias. k only fixes a rep who is uniformly too
 *    optimistic or too pessimistic. It cannot fix a rep whose numbers carry no
 *    information at all. The Brier skill score answers that: is their number
 *    better than just assuming every deal closes at the team average? A
 *    negative skill score means the honest thing to do is ignore their input
 *    and use the base rate.
 *
 * Usage
 *   node scripts/rep-calibration.mjs                        the MANUAL block below
 *   node scripts/rep-calibration.mjs --stated 50 --closed 40 --won 10
 *   node scripts/rep-calibration.mjs --deals "50:won,50:lost,80:won,30:lost"
 *   node scripts/rep-calibration.mjs --file closed.csv      stated,outcome[,rep]
 *   node scripts/rep-calibration.mjs --live                 read HubSpot, per rep
 *   node scripts/rep-calibration.mjs --live --min-lead-days 3
 *   node scripts/rep-calibration.mjs --deals "..." --pipeline "120@50,40@80"
 *
 * Options
 *   --prior N          shrinkage strength in pseudo-deals (default 10)
 *   --bucket-prior N   shrinkage for the per-value table (default 5)
 *   --min-k / --max-k  clamp on the trust factor (default 0.25 / 2.5)
 *   --min-lead-days N  --live only: ignore probabilities typed in fewer than N
 *                      days before the close date (default 1)
 *   --token XXX        HubSpot token, else ECHOBARRIER_HUBSPOT_ACCESS_TOKEN
 *
 * Nothing here writes anywhere. It reads and prints.
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// MANUAL INPUT — edit this and run with no arguments.
// `p` is what the rep said (50 or 0.5, both understood), `won` is what happened.
// ---------------------------------------------------------------------------
const MANUAL = {
  label: 'Lazy fifty-percenter',
  deals: [
    { p: 50, won: true },
    { p: 50, won: false },
    { p: 50, won: false },
    { p: 50, won: false },
    { p: 50, won: true },
    { p: 50, won: false },
    { p: 50, won: false },
    { p: 50, won: false },
    { p: 80, won: true },
    { p: 80, won: false },
    { p: 30, won: false },
    { p: 30, won: false },
  ],
  // What is still open, as units@stated. Optional.
  pipeline: [
    { units: 120, p: 50 },
    { units: 40, p: 80 },
  ],
}

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

/** 50, "50%", 0.5 and "0.5" all mean the same thing. */
export function normaliseP(v) {
  const n = typeof v === 'string' ? Number(v.replace('%', '').trim()) : Number(v)
  if (!Number.isFinite(n)) return null
  if (n < 0) return null
  if (n <= 1) return n          // 0.5
  if (n <= 100) return n / 100  // 50
  return null
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const pct = (v) => `${(v * 100).toFixed(0)}%`

/**
 * Everything about one rep, from their closed deals.
 * `deals` are { p: 0..1, won: boolean }.
 */
export function calibrate(deals, opts = {}) {
  const prior = opts.prior ?? 10
  const bucketPrior = opts.bucketPrior ?? 5
  const minK = opts.minK ?? 0.25
  const maxK = opts.maxK ?? 2.5

  const n = deals.length
  if (n === 0) return { n: 0 }

  const expected = deals.reduce((a, d) => a + d.p, 0)
  const wins = deals.reduce((a, d) => a + (d.won ? 1 : 0), 0)
  const baseRate = wins / n

  // The trust factor. Shrunk toward 1 so a thin history cannot swing it.
  const kRaw = expected > 0 ? wins / expected : null
  const kShrunk = (wins + prior) / (expected + prior)
  const k = clamp(kShrunk, minK, maxK)

  // Brier: mean squared error of the stated probability. Lower is better.
  // The comparison is against saying "every deal is the team average", which
  // takes no effort at all — if the rep cannot beat that, their number carries
  // no information and calibrating it will not create any.
  const brier = deals.reduce((a, d) => a + (d.p - (d.won ? 1 : 0)) ** 2, 0) / n
  const brierBase = deals.reduce((a, d) => a + (baseRate - (d.won ? 1 : 0)) ** 2, 0) / n
  const skill = brierBase > 0 ? 1 - brier / brierBase : 0

  // Per stated value: what they say against what happens, with the same
  // shrinkage so a bucket of three deals does not shout.
  const byValue = new Map()
  for (const d of deals) {
    const row = byValue.get(d.p) ?? { p: d.p, n: 0, won: 0 }
    row.n += 1
    row.won += d.won ? 1 : 0
    byValue.set(d.p, row)
  }
  const buckets = [...byValue.values()]
    .sort((a, b) => a.p - b.p)
    .map((b) => ({
      ...b,
      actual: b.won / b.n,
      calibrated: (b.won + bucketPrior * b.p) / (b.n + bucketPrior),
    }))

  // Do they at least rank deals correctly? A rep can be badly calibrated and
  // still useful if their 80s beat their 30s — that is fixable with a factor.
  // Non-monotone means the ordering itself is noise.
  let monotone = true
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].actual < buckets[i - 1].actual - 1e-9) monotone = false
  }

  // The laziness test: how much of their judgement is one repeated number.
  // Effective choices is exp(entropy) — 1.0 means they only ever say one thing,
  // 5.0 means they spread across about five values.
  const counts = [...byValue.values()].map((b) => b.n / n)
  const entropy = -counts.reduce((a, q) => a + (q > 0 ? q * Math.log(q) : 0), 0)
  const modalShare = Math.max(...counts)

  return {
    n, wins, expected, baseRate, kRaw, kShrunk, k, minK, maxK, prior, bucketPrior,
    brier, brierBase, skill, buckets, monotone,
    modalShare, effectiveChoices: Math.exp(entropy),
    distinctValues: byValue.size,
  }
}

/** What an open deal's stated probability becomes once the factor is applied. */
export const calibratedP = (p, k) => clamp(p * k, 0.02, 0.98)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function report(label, c, pipeline, opts) {
  const line = '─'.repeat(64)
  console.log(`\n${line}\n${label}\n${line}`)
  if (!c.n) return console.log('No closed deals with a stated probability. Nothing to measure.')

  console.log(`Closed deals scored      ${c.n}`)
  console.log(`They predicted           ${c.expected.toFixed(1)} wins`)
  console.log(`They actually won        ${c.wins}`)
  console.log(`Their real hit rate      ${pct(c.baseRate)}`)
  console.log('')
  console.log(`Raw factor      W / E    ${c.kRaw === null ? 'n/a' : c.kRaw.toFixed(3)}`)
  console.log(`Trust factor    k        ${c.k.toFixed(3)}   (shrunk with ${c.prior} prior deals${
    c.k !== c.kShrunk ? `, clamped to ${c.minK}–${c.maxK}` : ''})`)
  const verdict =
    c.k > 1.1 ? 'They UNDERSELL. Their deals close more often than they claim.'
    : c.k < 0.9 ? 'They OVERSELL. Trust their numbers less than they state.'
    : 'About right. Take their number at face value.'
  console.log(`                         ${verdict}`)

  console.log('\nStated  deals   won   actual   calibrated')
  for (const b of c.buckets) {
    console.log(
      `${pct(b.p).padStart(6)}  ${String(b.n).padStart(5)}  ${String(b.won).padStart(4)}   ` +
      `${pct(b.actual).padStart(6)}   ${pct(b.calibrated).padStart(10)}`
    )
  }

  console.log('\nIs the number worth anything at all')
  console.log(`  Brier score            ${c.brier.toFixed(4)}  (0 perfect, lower is better)`)
  console.log(`  Same, at the base rate ${c.brierBase.toFixed(4)}  (guessing ${pct(c.baseRate)} every time)`)
  console.log(`  Skill                  ${(c.skill * 100).toFixed(1)}%`)
  if (c.skill <= 0) {
    console.log('  🔴 Their probabilities are no better than assuming every deal is average.')
    console.log('     Calibrating a number that carries no information does not create any:')
    console.log(`     forecast these deals at the base rate ${pct(c.baseRate)} instead.`)
  }
  console.log(`  Ordering               ${c.monotone ? 'monotone — higher stated does win more often' : '🔴 not monotone — their 80s do not beat their 30s'}`)
  console.log(`  Spread                 ${c.distinctValues} distinct values, ${pct(c.modalShare)} on one of them, ${c.effectiveChoices.toFixed(1)} effective choices`)
  if (c.modalShare > 0.4) {
    console.log('  🔴 Most of their judgement is one repeated number. That is the lazy pattern:')
    console.log('     the factor still corrects the level, but it cannot rank deals they did not rank.')
  }

  if (pipeline?.length) {
    const raw = pipeline.reduce((a, d) => a + d.units * d.p, 0)
    const cal = pipeline.reduce((a, d) => a + d.units * calibratedP(d.p, c.k), 0)
    const units = pipeline.reduce((a, d) => a + d.units, 0)
    console.log('\nOpen pipeline through this factor')
    console.log(`  ${units} units across ${pipeline.length} deal line(s)`)
    console.log(`  At stated probability    ${raw.toFixed(1)} units`)
    console.log(`  At calibrated            ${cal.toFixed(1)} units   (${cal >= raw ? '+' : ''}${(cal - raw).toFixed(1)})`)
    for (const d of pipeline) {
      console.log(`    ${String(d.units).padStart(5)} @ ${pct(d.p).padStart(4)} → ${pct(calibratedP(d.p, c.k)).padStart(4)}  = ${(d.units * calibratedP(d.p, c.k)).toFixed(1)} units`)
    }
  }
  if (opts?.note) console.log(`\n${opts.note}`)
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function args() {
  const out = { _: [] }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) { out._.push(a[i]); continue }
    const key = a[i].slice(2)
    const next = a[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/** "50:won, 50:lost, 80:won" or "50:1,50:0" */
function parseDeals(s) {
  return s.split(',').map((part) => {
    const [pRaw, outcome] = part.split(':').map((x) => x.trim())
    const p = normaliseP(pRaw)
    if (p === null) throw new Error(`cannot read a probability from "${pRaw}"`)
    const won = /^(won|w|1|true|yes|y)$/i.test(outcome ?? '')
    return { p, won }
  })
}

/** "120@50, 40@80" */
function parsePipeline(s) {
  return s.split(',').map((part) => {
    const [units, p] = part.split('@').map((x) => x.trim())
    return { units: Number(units), p: normaliseP(p) }
  })
}

/** stated,outcome[,rep] — one line per closed deal, a header line is ignored. */
function parseCsv(text) {
  const rows = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^stated/i.test(line)) continue
    const [p, outcome, rep] = line.split(',').map((x) => x.trim())
    const prob = normaliseP(p)
    if (prob === null) continue
    rows.push({ p: prob, won: /^(won|w|1|true|yes|y)$/i.test(outcome ?? ''), rep: rep || 'all' })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Live mode — HubSpot
// ---------------------------------------------------------------------------

const PROBABILITY_PROPERTY = 'win_probability'

function hubspotToken(argv) {
  if (argv.token && argv.token !== true) return String(argv.token)
  if (process.env.ECHOBARRIER_HUBSPOT_ACCESS_TOKEN) return process.env.ECHOBARRIER_HUBSPOT_ACCESS_TOKEN
  // A variable set in ~/.zshrc without `export` is invisible to a child
  // process, which reads as a dead key rather than a missing one. Reading the
  // file directly turns that into a working run instead of a confusing 401.
  try {
    const zshrc = readFileSync(`${process.env.HOME}/.zshrc`, 'utf8')
    const m = zshrc.match(/ECHOBARRIER_HUBSPOT_ACCESS_TOKEN=["']?([^"'\s]+)/)
    if (m) return m[1]
  } catch { /* fall through to the error below */ }
  throw new Error('No HubSpot token. Pass --token, or export ECHOBARRIER_HUBSPOT_ACCESS_TOKEN.')
}

async function hs(token, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`HubSpot ${path} → ${res.status} ${await res.text()}`)
  return res.json()
}

async function live(argv) {
  const token = hubspotToken(argv)
  const minLead = Number(argv['min-lead-days'] ?? 1)

  const deals = []
  let after
  do {
    const page = await hs(token, '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: PROBABILITY_PROPERTY, operator: 'HAS_PROPERTY' },
        { propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' },
      ] }],
      properties: ['dealname', PROBABILITY_PROPERTY, 'hubspot_owner_id', 'hs_is_closed_won', 'closedate'],
      limit: 200,
      after,
    })
    deals.push(...(page.results ?? []))
    after = page.paging?.next?.after
  } while (after)

  // When was the probability FIRST typed in, against when the deal closed.
  const history = new Map()
  for (let i = 0; i < deals.length; i += 50) {
    const batch = await hs(token, '/crm/v3/objects/deals/batch/read', {
      inputs: deals.slice(i, i + 50).map((d) => ({ id: d.id })),
      properties: ['closedate'],
      propertiesWithHistory: [PROBABILITY_PROPERTY],
    })
    for (const r of batch.results ?? []) {
      const versions = r.propertiesWithHistory?.[PROBABILITY_PROPERTY] ?? []
      const first = versions.length ? versions.map((v) => v.timestamp).sort()[0] : null
      history.set(r.id, first)
    }
  }

  const owners = new Map()
  const ownerPage = await hs(token, '/crm/v3/owners?limit=200')
  for (const o of ownerPage.results ?? []) {
    owners.set(o.id, [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id)
  }

  const byRep = new Map()
  let dropped = 0
  for (const d of deals) {
    const p = normaliseP(d.properties[PROBABILITY_PROPERTY])
    if (p === null) continue
    const closed = d.properties.closedate ? Date.parse(d.properties.closedate) : null
    const stamped = history.get(d.id) ? Date.parse(history.get(d.id)) : null
    const leadDays = closed && stamped ? (closed - stamped) / 86_400_000 : null
    if (minLead > 0 && (leadDays === null || leadDays < minLead)) { dropped++; continue }
    const rep = owners.get(d.properties.hubspot_owner_id) ?? d.properties.hubspot_owner_id ?? 'unassigned'
    const list = byRep.get(rep) ?? []
    list.push({ p, won: d.properties.hs_is_closed_won === 'true' })
    byRep.set(rep, list)
  }

  console.log(`HubSpot: ${deals.length} closed deals carry ${PROBABILITY_PROPERTY}.`)
  console.log(`Dropped ${dropped} whose probability was first entered less than ${minLead} day(s) before the close`)
  console.log('(a probability typed on the day of the close is a record, not a forecast).')

  const opts = {
    prior: Number(argv.prior ?? 10),
    bucketPrior: Number(argv['bucket-prior'] ?? 5),
    minK: Number(argv['min-k'] ?? 0.25),
    maxK: Number(argv['max-k'] ?? 2.5),
  }
  for (const [rep, list] of [...byRep.entries()].sort((a, b) => b[1].length - a[1].length)) {
    report(rep, calibrate(list, opts), null, opts)
  }
  if (byRep.size === 0) console.log('\nNothing left to score after the lead-time filter.')
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const argv = args()
  if (argv.help || argv.h) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 61).join('\n'))
    return
  }
  const opts = {
    prior: Number(argv.prior ?? 10),
    bucketPrior: Number(argv['bucket-prior'] ?? 5),
    minK: Number(argv['min-k'] ?? 0.25),
    maxK: Number(argv['max-k'] ?? 2.5),
  }
  const pipeline = argv.pipeline && argv.pipeline !== true ? parsePipeline(argv.pipeline) : null

  if (argv.live) return live(argv)

  if (argv.file && argv.file !== true) {
    const rows = parseCsv(readFileSync(argv.file, 'utf8'))
    const byRep = new Map()
    for (const r of rows) byRep.set(r.rep, [...(byRep.get(r.rep) ?? []), r])
    for (const [rep, list] of byRep) report(rep, calibrate(list, opts), pipeline, opts)
    return
  }

  if (argv.deals && argv.deals !== true) {
    return report('Manual list', calibrate(parseDeals(argv.deals), opts), pipeline, opts)
  }

  // Summary form: they say X on everything, they closed W of N.
  if (argv.stated !== undefined) {
    const p = normaliseP(argv.stated)
    const n = Number(argv.closed ?? argv.deals ?? 0)
    const w = Number(argv.won ?? 0)
    if (p === null || !n) throw new Error('need --stated <percent> --closed <n> --won <n>')
    const list = Array.from({ length: n }, (_, i) => ({ p, won: i < w }))
    return report(`Says ${pct(p)} on everything`, calibrate(list, opts), pipeline, opts)
  }

  const manual = MANUAL.deals.map((d) => ({ p: normaliseP(d.p), won: !!d.won }))
  report(MANUAL.label, calibrate(manual, opts),
    pipeline ?? MANUAL.pipeline?.map((d) => ({ units: d.units, p: normaliseP(d.p) })), opts)
  console.log('\nEdit the MANUAL block at the top of this file, or pass --deals / --stated / --live.')
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
