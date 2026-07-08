import 'server-only'
import { createMfgClient } from '@/lib/supabase/mfg'

// EUR→USD FX for the Group→USA commercial-invoice leg. Reads the mfg project's
// fx_weekly (pair='EUR_USD', weekly avg_rate, source frankfurter.app).
//
// Juraj's spec: "3-month average, auto-updated QUARTERLY" — a rate that is STABLE
// within a quarter (customs/audit want the same rate for every shipment in a
// period), not one that drifts on every invoice. So the default method is
// 'quarterly': the average of the PREVIOUS calendar quarter's weekly rates,
// which is a pure function of the quarter — every invoice generated in Q3 gets
// the identical Q2 average, and it steps once at the quarter boundary. No extra
// table/cron needed; the resolved rate is still snapshotted onto each invoice.
// 'rolling_13w' (continuous ~3-month avg) and 'spot' (latest week) are kept.

export type FxMethod = 'quarterly' | 'rolling_13w' | 'spot'
export interface FxRate {
  pair: string
  rate: number
  method: FxMethod
  week_start: string | null
  /** Human basis, e.g. "Q2 2026 average (13 wks)" or "latest week 2026-06-22". */
  basis: string
  /** Newest fx_weekly week feeding the rate — for staleness display. */
  latest_week: string | null
  /** Weeks that went into the average. */
  weeks_used: number
}

const round4 = (v: number) => Math.round(v * 10000) / 10000

function quarterOf(d: Date): { year: number; q: number; start: Date } {
  const q = Math.floor(d.getUTCMonth() / 3) // 0..3
  return { year: d.getUTCFullYear(), q, start: new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)) }
}

/**
 * Pure: pick the rate from fx_weekly rows (passed newest-first). `asOf` is only
 * used by the 'quarterly' method to locate the quarter window. Exported for tests.
 */
export function pickFxRate(
  rows: { week_start_date: string; avg_rate: number | string }[],
  method: FxMethod,
  asOf: Date
): FxRate | null {
  const clean = rows
    .map((r) => ({ week: r.week_start_date, rate: Number(r.avg_rate) }))
    .filter((r) => Number.isFinite(r.rate) && r.week)
    .sort((a, b) => (a.week < b.week ? 1 : -1)) // newest-first
  if (!clean.length) return null
  const latest_week = clean[0].week

  if (method === 'spot') {
    return { pair: 'EUR_USD', rate: round4(clean[0].rate), method, week_start: clean[0].week, basis: `latest week ${clean[0].week}`, latest_week, weeks_used: 1 }
  }

  if (method === 'quarterly') {
    const cur = quarterOf(asOf)
    // Window = the PREVIOUS calendar quarter [prevStart, curStart).
    const prevStart = new Date(Date.UTC(cur.q === 0 ? cur.year - 1 : cur.year, cur.q === 0 ? 9 : (cur.q - 1) * 3, 1))
    const curStart = cur.start
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const win = clean.filter((r) => r.week >= iso(prevStart) && r.week < iso(curStart))
    // Fall back to the rolling window if the previous quarter has no data yet.
    const used = win.length ? win : clean.slice(0, 13)
    const avg = used.reduce((s, r) => s + r.rate, 0) / used.length
    const pq = cur.q === 0 ? 4 : cur.q
    const py = cur.q === 0 ? cur.year - 1 : cur.year
    return {
      pair: 'EUR_USD',
      rate: round4(avg),
      method,
      week_start: used[used.length - 1].week,
      basis: win.length ? `Q${pq} ${py} average (${used.length} wks)` : `rolling ${used.length}-wk average (no full prior quarter yet)`,
      latest_week,
      weeks_used: used.length,
    }
  }

  // rolling_13w
  const win = clean.slice(0, 13)
  const avg = win.reduce((s, r) => s + r.rate, 0) / win.length
  return { pair: 'EUR_USD', rate: round4(avg), method, week_start: win[win.length - 1].week, basis: `rolling ${win.length}-wk average`, latest_week, weeks_used: win.length }
}

export async function getEurUsdRate(method: FxMethod = 'quarterly'): Promise<FxRate | null> {
  const mfg = createMfgClient()
  // Pull enough history to cover a full prior quarter (~26 weeks is plenty).
  const { data, error } = await mfg
    .from('fx_weekly')
    .select('week_start_date, avg_rate')
    .eq('pair', 'EUR_USD')
    .order('week_start_date', { ascending: false })
    .limit(30)
  if (error || !data) return null
  return pickFxRate(data as { week_start_date: string; avg_rate: number | string }[], method, new Date())
}
