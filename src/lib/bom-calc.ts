import type { BomComponent } from '@/lib/erp-types'

// Pure BOM costing (no server-only) so it's unit-testable. The verified formula:
//   component.extended_eur = qty × unit_price
//   sro_components_eur      = Σ extended
//   sro_duty_8pct_eur       = 8% × Σ(extended where dutiable)
//   sro_admin_eur           = flat per model (unchanged by material prices)
//   sro_total_eur           = components + duty + admin
//   bamida_total_eur        = bamida_man_eur + bamida_print_eur (Bamida labour, unchanged)
//   bom_total_eur           = bamida_total + sro_total

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
export const round2 = (v: number): number => Math.round(v * 100) / 100
export const round4 = (v: number): number => Math.round(v * 10000) / 10000

/**
 * Re-price each recipe component from the master. Falls back to the snapshot price
 * when a code isn't mastered OR when a mastered value is non-finite (so a corrupt
 * direct DB/sync write can never silently zero a component's cost).
 */
export function priceComponents(detail: BomComponent[], priceMap: Map<string, number>): BomComponent[] {
  return detail.map((c) => {
    const mastered = priceMap.get(c.code)
    const unit = mastered != null && Number.isFinite(mastered) ? mastered : num(c.unit_cost_eur)
    return { ...c, unit_cost_eur: round4(unit), extended_eur: round4(num(c.qty) * unit) }
  })
}

export interface BomTotals {
  sro_components_eur: number
  sro_duty_8pct_eur: number
  sro_admin_eur: number
  sro_total_eur: number
  bamida_total_eur: number
  bom_total_eur: number
}

/** Roll priced components + (unchanged) Bamida labour + flat admin into the totals. */
export function recomputeTotals(priced: BomComponent[], man: number, print: number, admin: number): BomTotals {
  const components = priced.reduce((s, c) => s + num(c.extended_eur), 0)
  const duty = priced.reduce((s, c) => s + (c.dutiable ? num(c.extended_eur) : 0), 0) * 0.08
  const sroTotal = components + duty + admin
  const bamidaTotal = man + print
  return {
    sro_components_eur: round4(components),
    sro_duty_8pct_eur: round4(duty),
    sro_admin_eur: round4(admin),
    sro_total_eur: round4(sroTotal),
    bamida_total_eur: round4(bamidaTotal),
    bom_total_eur: round4(bamidaTotal + sroTotal),
  }
}
