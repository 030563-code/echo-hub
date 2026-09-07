import 'server-only'

import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createMfgClient } from '@/lib/supabase/mfg'
import { num, round2, priceComponents, recomputeTotals } from '@/lib/bom-calc'
import type { BomComponent, BomMasterRow, MaterialPrice, SroPoBom, SroPoBomLine } from '@/lib/erp-types'

const mfgConfigured = () =>
  Boolean(process.env.MFG_SUPABASE_URL && process.env.MFG_SUPABASE_SERVICE_ROLE_KEY)

type Mfg = ReturnType<typeof createMfgClient>

/** Latest week_start_date in the mfg snapshot, or null. */
async function latestWeek(mfg: Mfg): Promise<string | null> {
  const { data } = await mfg
    .from('bom_weekly_snapshot')
    .select('week_start_date')
    .order('week_start_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.week_start_date ?? null
}

// ---------------------------------------------------------------------------
// Material-price master (the Hub's price source of truth). The Sheets→n8n sync
// supplies only the recipe (qty/dutiable/structure) in component_detail; prices
// come from material_prices, applied + rolled up here. Verified cost formula:
//   component.extended_eur = qty × unit_price
//   sro_components_eur      = Σ extended
//   sro_duty_8pct_eur       = 8% × Σ(extended where dutiable)
//   sro_admin_eur           = flat per model (unchanged by material prices)
//   sro_total_eur           = components + duty + admin
//   bamida_total_eur        = bamida_man_eur + bamida_print_eur (Bamida labour, unchanged)
//   bom_total_eur           = bamida_total + sro_total
// ---------------------------------------------------------------------------

/** code → unit_price_eur from material_prices. */
async function loadMaterialPriceMap(mfg: Mfg): Promise<Map<string, number>> {
  const { data } = await mfg.from('material_prices').select('material_code, unit_price_eur')
  const m = new Map<string, number>()
  for (const r of data ?? []) {
    const row = r as { material_code: string; unit_price_eur: unknown }
    m.set(row.material_code, num(row.unit_price_eur))
  }
  return m
}

interface MfgBomRow {
  model_code: string
  component_detail: BomComponent[] | null
  bamida_man_eur: string | number | null
  bamida_print_eur: string | number | null
  sro_admin_eur: string | number | null
}

interface PoForExplode {
  id: string
  po_number: string
  master_ref: string | null
  from_entity: string
  to_entity: string
  approved_at: string | null
  created_at: string
  lines?: { sku: string; product_name: string | null; quantity: number }[]
}

interface ExplodeCtx {
  skuToModel: Map<string, string | null>
  bomByModel: Map<string, MfgBomRow>
  priceMap: Map<string, number>
}

/** Explode ONE SRO PO into its BOM using a prepared context (pure given the ctx). */
function explodePo(po: PoForExplode, ctx: ExplodeCtx): SroPoBom {
  const lines: SroPoBomLine[] = (po.lines ?? []).map((l) => {
    const model = ctx.skuToModel.get(l.sku) ?? null
    const bom = model ? ctx.bomByModel.get(model) : undefined
    const priced = priceComponents(bom?.component_detail ?? [], ctx.priceMap)
    const components = priced.map((c) => ({
      ...c,
      line_qty: round2(num(c.qty) * l.quantity),
      line_extended_eur: round2(num(c.extended_eur) * l.quantity),
    }))
    const man = num(bom?.bamida_man_eur)
    const print = num(bom?.bamida_print_eur)
    const admin = num(bom?.sro_admin_eur)
    const t = recomputeTotals(priced, man, print, admin)
    const componentsUnit = t.sro_components_eur
    const bamidaUnit = componentsUnit + man + print
    const sroUnit = t.sro_total_eur
    return {
      sku: l.sku,
      product_name: l.product_name,
      quantity: l.quantity,
      model_code: model,
      has_bom: Boolean(bom),
      components,
      bamida_man_eur: man,
      bamida_print_eur: print,
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

/** Build the explosion context (catalog map + mfg week/prices/BOMs) for a set of POs. */
async function buildExplodeCtx(
  ops: { from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown[] | null }> } },
  mfg: Mfg,
  pos: PoForExplode[]
): Promise<{ ctx: ExplodeCtx; week: string | null }> {
  const { data: catalog } = await ops.from('po_product_catalog').select('sku, bom_model_code')
  const skuToModel = new Map<string, string | null>(
    ((catalog ?? []) as { sku: string; bom_model_code: string | null }[]).map((c) => [c.sku, c.bom_model_code])
  )
  const week = await latestWeek(mfg)
  const priceMap = await loadMaterialPriceMap(mfg)
  const bomByModel = new Map<string, MfgBomRow>()
  if (week) {
    const models = [
      ...new Set(pos.flatMap((p) => (p.lines ?? []).map((l) => skuToModel.get(l.sku)).filter((m): m is string => Boolean(m)))),
    ]
    if (models.length) {
      const { data: boms } = await mfg
        .from('bom_weekly_snapshot')
        .select('model_code, component_detail, bamida_man_eur, bamida_print_eur, sro_admin_eur')
        .eq('week_start_date', week)
        .in('model_code', models)
      for (const b of (boms ?? []) as MfgBomRow[]) bomByModel.set(b.model_code, b)
    }
  }
  return { ctx: { skuToModel, bomByModel, priceMap }, week }
}

/**
 * Approved EB_GROUP_TO_SRO POs with their BOM. The cost FROZEN at approval
 * (`cost_snapshot`) is authoritative and returned as-is; only POs that predate the
 * snapshot column are live-exploded from the current master prices.
 */
export async function loadSroPoBoms(): Promise<{ pos: SroPoBom[]; week: string | null; error?: string }> {
  const supabase = await createServerClient()

  const { data: pos } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, cost_snapshot, cost_snapshot_at, lines:purchase_order_lines(sku, product_name, quantity)'
    )
    .eq('leg', 'EB_GROUP_TO_SRO')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })

  if (!pos || pos.length === 0) return { pos: [], week: null }

  // Only the un-frozen (legacy) POs need a live explosion + the mfg round-trip.
  const live = pos.filter((p) => !(p as { cost_snapshot?: unknown }).cost_snapshot) as unknown as PoForExplode[]
  let ctx: ExplodeCtx | null = null
  let week: string | null = null
  if (live.length) {
    if (!mfgConfigured()) {
      return { pos: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
    }
    const built = await buildExplodeCtx(supabase, createMfgClient(), live)
    ctx = built.ctx
    week = built.week
  }

  const out: SroPoBom[] = pos.map((po) => {
    const snap = (po as { cost_snapshot?: unknown }).cost_snapshot
    if (snap) {
      return { ...(snap as SroPoBom), cost_frozen: true, cost_snapshot_at: (po as { cost_snapshot_at?: string | null }).cost_snapshot_at ?? null }
    }
    return explodePo(po as unknown as PoForExplode, ctx as ExplodeCtx)
  })
  return { pos: out, week }
}

/**
 * Freeze the exploded SRO cost onto a PO at approval (authoritative — it then
 * drives the record and the Xero PO instead of floating with material_prices).
 * Best-effort: swallows errors so a mfg hiccup never blocks an approval.
 */
export async function snapshotSroPoCost(poId: string): Promise<{ ok: boolean; sro_total?: number }> {
  try {
    if (!mfgConfigured()) return { ok: false }
    const admin = createAdminClient()
    const { data: po } = await admin
      .from('purchase_orders')
      .select('id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, lines:purchase_order_lines(sku, product_name, quantity)')
      .eq('id', poId)
      .maybeSingle()
    if (!po) return { ok: false }
    const { ctx } = await buildExplodeCtx(
      admin as unknown as Parameters<typeof buildExplodeCtx>[0],
      createMfgClient(),
      [po as unknown as PoForExplode]
    )
    const snap = explodePo(po as unknown as PoForExplode, ctx)
    await admin
      .from('purchase_orders')
      .update({ cost_snapshot: snap, sro_cost_snapshot_eur: snap.sro_total, cost_snapshot_at: new Date().toISOString() })
      .eq('id', poId)
    return { ok: true, sro_total: snap.sro_total }
  } catch (e) {
    console.error('snapshotSroPoCost failed', poId, e)
    return { ok: false }
  }
}

/** Master BOM rows for the latest week, PRICED from material_prices + a Δ vs the synced snapshot total. */
export async function loadBomMaster(): Promise<{ rows: BomMasterRow[]; week: string | null; error?: string }> {
  if (!mfgConfigured()) {
    return { rows: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
  }
  try {
    const mfg = createMfgClient()
    const week = await latestWeek(mfg)
    if (!week) return { rows: [], week: null }

    const priceMap = await loadMaterialPriceMap(mfg)
    const { data, error } = await mfg
      .from('bom_weekly_snapshot')
      .select(
        'model_code, product_line, week_start_date, bamida_man_eur, bamida_print_eur, sro_admin_eur, bom_total_eur, fx_gbp_eur, bom_change_pct, component_detail'
      )
      .eq('week_start_date', week)
      .order('model_code')

    if (error) return { rows: [], week, error: 'Failed to load BOM master.' }

    const rows: BomMasterRow[] = (data ?? []).map((r) => {
      const man = r.bamida_man_eur == null ? 0 : num(r.bamida_man_eur)
      const print = r.bamida_print_eur == null ? 0 : num(r.bamida_print_eur)
      const admin = r.sro_admin_eur == null ? 0 : num(r.sro_admin_eur)
      const priced = priceComponents((r.component_detail ?? []) as BomComponent[], priceMap)
      const t = recomputeTotals(priced, man, print, admin)
      const originalBomTotal = r.bom_total_eur == null ? null : num(r.bom_total_eur)
      return {
        model_code: r.model_code,
        product_line: r.product_line,
        week_start_date: r.week_start_date,
        bamida_man_eur: man,
        bamida_print_eur: print,
        bamida_total_eur: t.bamida_total_eur,
        sro_components_eur: t.sro_components_eur,
        sro_duty_8pct_eur: t.sro_duty_8pct_eur,
        sro_admin_eur: admin,
        sro_total_eur: t.sro_total_eur,
        bom_total_eur: t.bom_total_eur,
        fx_gbp_eur: r.fx_gbp_eur == null ? null : num(r.fx_gbp_eur),
        bom_change_pct: r.bom_change_pct == null ? null : num(r.bom_change_pct),
        original_bom_total_eur: originalBomTotal,
        component_detail: priced,
      }
    })
    return { rows, week }
  } catch {
    return { rows: [], week: null, error: 'Failed to reach the manufacturing data source.' }
  }
}

/** The material-price master + how many products each material is used in (the Materials editor). */
export async function loadMaterials(): Promise<{ materials: MaterialPrice[]; week: string | null; error?: string }> {
  if (!mfgConfigured()) {
    return { materials: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
  }
  try {
    const mfg = createMfgClient()
    const week = await latestWeek(mfg)

    // Usage counts from the latest week's recipes.
    const usage = new Map<string, Set<string>>()
    if (week) {
      const { data: rows } = await mfg
        .from('bom_weekly_snapshot')
        .select('model_code, component_detail')
        .eq('week_start_date', week)
      for (const r of rows ?? []) {
        const detail = ((r as { component_detail: BomComponent[] | null }).component_detail) ?? []
        const model = (r as { model_code: string }).model_code
        for (const c of detail) {
          if (!c.code) continue
          const set = usage.get(c.code) ?? new Set<string>()
          set.add(model)
          usage.set(c.code, set)
        }
      }
    }

    const { data: prices } = await mfg
      .from('material_prices')
      .select('material_code, description, unit_price_eur, currency, updated_at, updated_by_label')
    const materials: MaterialPrice[] = (prices ?? [])
      .map((p) => {
        const r = p as {
          material_code: string
          description: string | null
          unit_price_eur: unknown
          currency: string | null
          updated_at: string
          updated_by_label: string | null
        }
        return {
          material_code: r.material_code,
          description: r.description,
          unit_price_eur: num(r.unit_price_eur),
          currency: r.currency ?? 'EUR',
          used_in_products: usage.get(r.material_code)?.size ?? 0,
          updated_at: r.updated_at,
          updated_by_label: r.updated_by_label,
        }
      })
      .sort((a, b) => b.used_in_products - a.used_in_products || a.material_code.localeCompare(b.material_code))
    return { materials, week }
  } catch {
    return { materials: [], week: null, error: 'Failed to reach the manufacturing data source.' }
  }
}
