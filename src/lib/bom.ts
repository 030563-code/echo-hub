import 'server-only'

import { createServerClient } from '@/lib/supabase/server'
import { createMfgClient } from '@/lib/supabase/mfg'
import type { BomComponent, BomMasterRow, SroPoBom, SroPoBomLine } from '@/lib/erp-types'

// Numeric columns come back from Supabase as strings; component_detail values are
// already numbers. Coerce safely.
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

const mfgConfigured = () =>
  Boolean(process.env.MFG_SUPABASE_URL && process.env.MFG_SUPABASE_SERVICE_ROLE_KEY)

/** Latest week_start_date in the mfg snapshot, or null. */
async function latestWeek(mfg: ReturnType<typeof createMfgClient>): Promise<string | null> {
  const { data } = await mfg
    .from('bom_weekly_snapshot')
    .select('week_start_date')
    .order('week_start_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.week_start_date ?? null
}

interface MfgBomRow {
  model_code: string
  component_detail: BomComponent[] | null
  bamida_man_eur: string | number | null
  bamida_print_eur: string | number | null
  sro_components_eur: string | number | null
  sro_duty_8pct_eur: string | number | null
  sro_admin_eur: string | number | null
}

/**
 * Live-explode every approved EB_GROUP_TO_SRO PO into its BOM from the CURRENT
 * master mfg snapshot (Decision: no per-PO snapshot — the PO reads master live).
 * Returns one entry per approved SRO PO with each line's components × qty, the
 * Bamida draft-PO total (components + man + print) and the recorded SRO cost.
 */
export async function loadSroPoBoms(): Promise<{ pos: SroPoBom[]; week: string | null; error?: string }> {
  const supabase = await createServerClient()

  const { data: pos } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, lines:purchase_order_lines(sku, product_name, quantity)'
    )
    .eq('leg', 'EB_GROUP_TO_SRO')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })

  if (!pos || pos.length === 0) return { pos: [], week: null }

  const { data: catalog } = await supabase
    .from('po_product_catalog')
    .select('sku, bom_model_code')
  const skuToModel = new Map((catalog ?? []).map((c) => [c.sku as string, c.bom_model_code as string | null]))

  if (!mfgConfigured()) {
    return { pos: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
  }

  const mfg = createMfgClient()
  const week = await latestWeek(mfg)
  const bomByModel = new Map<string, MfgBomRow>()

  if (week) {
    const models = [
      ...new Set(
        pos.flatMap((p) =>
          (p.lines ?? []).map((l) => skuToModel.get(l.sku)).filter((m): m is string => Boolean(m))
        )
      ),
    ]
    if (models.length) {
      const { data: boms } = await mfg
        .from('bom_weekly_snapshot')
        .select(
          'model_code, component_detail, bamida_man_eur, bamida_print_eur, sro_components_eur, sro_duty_8pct_eur, sro_admin_eur'
        )
        .eq('week_start_date', week)
        .in('model_code', models)
      for (const b of (boms ?? []) as MfgBomRow[]) bomByModel.set(b.model_code, b)
    }
  }

  const explode = (po: (typeof pos)[number]): SroPoBom => {
    const lines: SroPoBomLine[] = (po.lines ?? []).map((l) => {
      const model = skuToModel.get(l.sku) ?? null
      const bom = model ? bomByModel.get(model) : undefined
      const detail = bom?.component_detail ?? []
      const components = detail.map((c) => ({
        ...c,
        line_qty: round2(num(c.qty) * l.quantity),
        line_extended_eur: round2(num(c.extended_eur) * l.quantity),
      }))
      const componentsUnit = detail.reduce((s, c) => s + num(c.extended_eur), 0)
      const bamidaMan = num(bom?.bamida_man_eur)
      const bamidaPrint = num(bom?.bamida_print_eur)
      const bamidaUnit = componentsUnit + bamidaMan + bamidaPrint
      const sroUnit = num(bom?.sro_components_eur) + num(bom?.sro_duty_8pct_eur) + num(bom?.sro_admin_eur)
      return {
        sku: l.sku,
        product_name: l.product_name,
        quantity: l.quantity,
        model_code: model,
        has_bom: Boolean(bom),
        components,
        bamida_man_eur: bamidaMan,
        bamida_print_eur: bamidaPrint,
        components_eur_unit: round2(componentsUnit),
        bamida_total_line: round2(bamidaUnit * l.quantity),
        sro_total_line: round2(sroUnit * l.quantity),
      }
    })
    return {
      id: po.id,
      po_number: po.po_number,
      master_ref: po.master_ref,
      from_entity: po.from_entity,
      to_entity: po.to_entity,
      approved_at: po.approved_at,
      created_at: po.created_at,
      lines,
      bamida_total: round2(lines.reduce((s, l) => s + l.bamida_total_line, 0)),
      sro_total: round2(lines.reduce((s, l) => s + l.sro_total_line, 0)),
    }
  }

  return { pos: pos.map(explode), week }
}

/** Load the editable master BOM rows for the latest week (component_detail + costs). */
export async function loadBomMaster(): Promise<{ rows: BomMasterRow[]; week: string | null; error?: string }> {
  if (!mfgConfigured()) {
    return { rows: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
  }
  try {
    const mfg = createMfgClient()
    const week = await latestWeek(mfg)
    if (!week) return { rows: [], week: null }

    const { data, error } = await mfg
      .from('bom_weekly_snapshot')
      .select(
        'model_code, product_line, week_start_date, bamida_man_eur, bamida_print_eur, bamida_total_eur, sro_components_eur, sro_duty_8pct_eur, sro_admin_eur, sro_total_eur, bom_total_eur, fx_gbp_eur, bom_change_pct, component_detail'
      )
      .eq('week_start_date', week)
      .order('model_code')

    if (error) return { rows: [], week, error: 'Failed to load BOM master.' }

    const rows: BomMasterRow[] = (data ?? []).map((r) => ({
      model_code: r.model_code,
      product_line: r.product_line,
      week_start_date: r.week_start_date,
      bamida_man_eur: r.bamida_man_eur == null ? null : num(r.bamida_man_eur),
      bamida_print_eur: r.bamida_print_eur == null ? null : num(r.bamida_print_eur),
      bamida_total_eur: r.bamida_total_eur == null ? null : num(r.bamida_total_eur),
      sro_components_eur: r.sro_components_eur == null ? null : num(r.sro_components_eur),
      sro_duty_8pct_eur: r.sro_duty_8pct_eur == null ? null : num(r.sro_duty_8pct_eur),
      sro_admin_eur: r.sro_admin_eur == null ? null : num(r.sro_admin_eur),
      sro_total_eur: r.sro_total_eur == null ? null : num(r.sro_total_eur),
      bom_total_eur: r.bom_total_eur == null ? null : num(r.bom_total_eur),
      fx_gbp_eur: r.fx_gbp_eur == null ? null : num(r.fx_gbp_eur),
      bom_change_pct: r.bom_change_pct == null ? null : num(r.bom_change_pct),
      component_detail: (r.component_detail ?? []) as BomComponent[],
    }))
    return { rows, week }
  } catch {
    return { rows: [], week: null, error: 'Failed to reach the manufacturing data source.' }
  }
}
