/**
 * Pure DDMRP buffer math — no IO, no dates-from-env, fully unit-testable.
 *
 * Zones are sized per DDMRP long-lead-time conventions: lead-time factor
 * 0.25, variability factor from measured CoV buckets (0.4 / 0.6 / 1.0).
 * NFP (net flow position) = on_hand + on_order + in_transit − firm_demand.
 * Trigger semantics (applied by the engine, not here): NFP ≤ yellowTop →
 * order up to greenTop. Demand spikes qualify at ≥50% of the red zone due
 * within DLT+30d. Service classes (core/slow) map to threshold tiers at the
 * engine level — this module is class-agnostic.
 */

export interface BufferProfile {
  adu: number; dltDays: number; ltFactor: number; varFactor: number
  moq: number; containerQty: number
}
export interface Zones { red: number; yellow: number; green: number; yellowTop: number; greenTop: number }

/**
 * Measured coefficient of variation → DDMRP variability factor bucket:
 * CoV < 1 → 0.4 (low), 1–2 → 0.6 (medium), > 2 → 1.0 (high).
 * Unknown CoV (null) → 1.0, the most conservative bucket.
 */
export function varFactorFromCov(cov: number | null): number {
  if (cov == null) return 1.0
  if (cov < 1) return 0.4
  if (cov <= 2) return 0.6
  return 1.0
}

/**
 * DDMRP zone sizing:
 *   yellow  = ADU × DLT                      (cycle stock over the lead time)
 *   redBase = ADU × DLT × ltFactor
 *   red     = redBase × (1 + varFactor)      (safety embedding variability)
 *   green   = max(redBase, MOQ, containerQty) (order-cycle / batch size)
 * Tops are cumulative: yellowTop = red + yellow; greenTop = red + yellow + green.
 * All zone values are rounded up to whole units.
 *
 * Input clamping (pathological-input guarantee — never NaN/negative output):
 * non-finite or negative `adu` is clamped to 0; a non-finite `varFactor`
 * defaults to varFactorFromCov(null) = 1.0 (most conservative).
 */
export function computeZones(p: BufferProfile): Zones {
  const adu = Number.isFinite(p.adu) ? Math.max(0, p.adu) : 0
  const varFactor = Number.isFinite(p.varFactor) ? p.varFactor : varFactorFromCov(null)
  const yellow = Math.ceil(adu * p.dltDays)
  const redBase = adu * p.dltDays * p.ltFactor
  const red = Math.ceil(redBase * (1 + varFactor))
  const green = Math.max(Math.ceil(redBase), p.moq, p.containerQty)
  return { red, yellow, green, yellowTop: red + yellow, greenTop: red + yellow + green }
}

export interface SpikeInput { qty: number; weight: number; qualified: boolean }

/**
 * Net flow position. `nfp` = onHand + inTransit + onOrder − firmDemand
 * (onOrder must arrive pre-deduped against in-transit shipment rows).
 * `projectedNfp` additionally subtracts probability-weighted qualified
 * spikes (qty × stage weight); unqualified spikes are ignored.
 */
export function computeNFP(i: { onHand: number; inTransit: number; onOrder: number;
  firmDemand: number; spikes: SpikeInput[] }) {
  const nfp = i.onHand + i.inTransit + i.onOrder - i.firmDemand
  const spikeLoad = i.spikes.filter(s => s.qualified)
    .reduce((a, s) => a + s.qty * s.weight, 0)
  return { nfp, projectedNfp: nfp - spikeLoad }
}

/**
 * Classify an NFP against zone tops and size the replenishment:
 * NFP > yellowTop → green (no action); NFP ≤ red → red; otherwise yellow.
 * When in yellow/red, actionQty = greenTop − NFP (order up to green-top).
 */
export function zoneFor(nfp: number, z: Zones): { zone: 'red'|'yellow'|'green'; actionQty: number } {
  if (nfp > z.yellowTop) return { zone: 'green', actionQty: 0 }
  const actionQty = z.greenTop - nfp
  return { zone: nfp <= z.red ? 'red' : 'yellow', actionQty }
}

export interface SpikeCandidate { dealId: string; qty: number; dueDate: string; lateStage: boolean; weight: number }

/**
 * Qualify demand spikes: a candidate qualifies when it is late-stage, its
 * qty ≥ 50% of the red zone (the DDMRP spike threshold), and its due date
 * falls inside the spike horizon (typically DLT + 30d), with a 1-day grace
 * for candidates due "today" across timezones.
 */
export function qualifySpikes(cands: SpikeCandidate[],
  opts: { redZone: number; horizonDays: number; today: Date }) {
  const threshold = 0.5 * opts.redZone
  const horizonMs = opts.horizonDays * 86_400_000
  return cands.filter(c => c.lateStage && c.qty >= threshold
    && Date.parse(c.dueDate) - opts.today.getTime() <= horizonMs
    && Date.parse(c.dueDate) >= opts.today.getTime() - 86_400_000)
}
