import { chosenModels, lineModels, modelMaps, type LineModels, type ModelBySku } from '@/lib/sku-model'
import 'server-only'

import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createMfgClient } from '@/lib/supabase/mfg'
import { bamidaLabour, num, round2, priceComponents, recomputeTotals, type HubBamidaPrice } from '@/lib/bom-calc'
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

// ---------------------------------------------------------------------------
// What the s.r.o. set under BOM: the model a product code is costed as
// (bom_product_model) and Bamida's prices (bom_bamida_price). Both tables are
// service role only; every caller here sits behind a page or action gate.
// ---------------------------------------------------------------------------

type HubPrice = HubBamidaPrice & { by: string | null; at: string }

const priceOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Throws rather than answering without them: a cost frozen from the sheet's
 * price when the Hub holds a corrected one is exactly the silent wrong these
 * tables exist to stop.
 */
async function loadHubBomChoices(): Promise<{ chosen: ModelBySku; prices: Map<string, HubPrice> }> {
  const admin = createAdminClient()
  const [models, prices] = await Promise.all([
    admin.from('bom_product_model').select('sku, model_code'),
    admin.from('bom_bamida_price').select('model_code, manufacturing_eur, printing_eur, updated_by_label, updated_at'),
  ])
  if (models.error) throw new Error(`Could not read the product models chosen under BOM: ${models.error.message}`)
  if (prices.error) throw new Error(`Could not read the Bamida prices set in the Hub: ${prices.error.message}`)
  const byModel = new Map<string, HubPrice>()
  for (const r of (prices.data ?? []) as { model_code: string; manufacturing_eur: unknown; printing_eur: unknown; updated_by_label: string | null; updated_at: string }[]) {
    byModel.set(r.model_code, {
      manufacturing_eur: priceOrNull(r.manufacturing_eur),
      printing_eur: priceOrNull(r.printing_eur),
      by: r.updated_by_label,
      at: r.updated_at,
    })
  }
  return { chosen: chosenModels((models.data ?? []) as { sku: string; model_code: string }[]), prices: byModel }
}

/** The models in the latest week of the bill of materials: what a product code can be costed as. */
export async function latestBomModels(): Promise<{ week: string | null; models: Set<string> }> {
  if (!mfgConfigured()) throw new Error('Manufacturing data source not configured (MFG_SUPABASE_* env).')
  const mfg = createMfgClient()
  const week = await latestWeek(mfg)
  if (!week) return { week: null, models: new Set() }
  const { data, error } = await mfg.from('bom_weekly_snapshot').select('model_code').eq('week_start_date', week)
  if (error) throw new Error(`Could not read the bill of materials: ${error.message}`)
  return { week, models: new Set(((data ?? []) as { model_code: string }[]).map((r) => r.model_code)) }
}

/** The rows the Product codes tab is built from (sku-model.ts productModelRows). */
export async function loadProductCodes() {
  const admin = createAdminClient()
  const [catalogue, master, chosen] = await Promise.all([
    admin.from('po_product_catalog').select('sku, product_name, bom_model_code, region, product_family, active'),
    admin.from('product_code_master').select('internal_sku, product_name, bom_model_code, product_family, is_active'),
    admin.from('bom_product_model').select('sku, model_code, updated_by_label, updated_at'),
  ])
  const error = catalogue.error ?? master.error ?? chosen.error
  if (error) {
    console.error('Could not read the product codes for the BOM page:', error.message)
    return { catalogue: [], master: [], chosen: [], error: 'Could not read the product codes.' }
  }
  return {
    catalogue: (catalogue.data ?? []) as { sku: string; product_name: string | null; bom_model_code: string | null; region: string | null; product_family: string | null; active: boolean | null }[],
    master: (master.data ?? []) as { internal_sku: string; product_name: string | null; bom_model_code: string | null; product_family: string | null; is_active: boolean | null }[],
    chosen: (chosen.data ?? []) as { sku: string; model_code: string; updated_by_label: string | null; updated_at: string }[],
    error: undefined as string | undefined,
  }
}

/** A code France, the UK, Group, North America or Japan orders under. */
export async function isKnownProductCode(sku: string): Promise<boolean> {
  const admin = createAdminClient()
  const [catalogue, master] = await Promise.all([
    admin.from('po_product_catalog').select('sku').eq('sku', sku).limit(1),
    admin.from('product_code_master').select('internal_sku').eq('internal_sku', sku).limit(1),
  ])
  if (catalogue.error || master.error) throw new Error('Could not read the product codes.')
  return (catalogue.data?.length ?? 0) + (master.data?.length ?? 0) > 0
}

/** What a product code is costed as today, and whether anybody chose it: for the audit trail. */
export async function currentProductModel(sku: string): Promise<{ chosen: string | null; listed: string | null }> {
  const admin = createAdminClient()
  const [chosen, catalogue, master] = await Promise.all([
    admin.from('bom_product_model').select('model_code').eq('sku', sku).maybeSingle<{ model_code: string }>(),
    admin.from('po_product_catalog').select('bom_model_code').eq('sku', sku).maybeSingle<{ bom_model_code: string | null }>(),
    admin.from('product_code_master').select('bom_model_code').eq('internal_sku', sku).maybeSingle<{ bom_model_code: string | null }>(),
  ])
  if (chosen.error) throw new Error(`Could not read the product model: ${chosen.error.message}`)
  return {
    chosen: chosen.data?.model_code ?? null,
    listed: catalogue.data?.bom_model_code || master.data?.bom_model_code || null,
  }
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
  skuModels: Map<string, LineModels>
  bomByModel: Map<string, MfgBomRow>
  priceMap: Map<string, number>
  hubPrices: Map<string, HubPrice>
}

/** Explode ONE SRO PO into its BOM using a prepared context (pure given the ctx). */
function explodePo(po: PoForExplode, ctx: ExplodeCtx): SroPoBom {
  const lines: SroPoBomLine[] = (po.lines ?? []).map((l) => {
    const { model, bomModel } = ctx.skuModels.get(l.sku) ?? { model: null, bomModel: null }
    const bom = bomModel ? ctx.bomByModel.get(bomModel) : undefined
    const priced = priceComponents(bom?.component_detail ?? [], ctx.priceMap)
    const components = priced.map((c) => ({
      ...c,
      line_qty: round2(num(c.qty) * l.quantity),
      line_extended_eur: round2(num(c.extended_eur) * l.quantity),
    }))
    const { man, print } = bamidaLabour(bom?.bamida_man_eur, bom?.bamida_print_eur, bomModel ? ctx.hubPrices.get(bomModel) : null)
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
      bom_model_code: bomModel,
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
  // Two tables know a SKU's model: the catalogue for the North American and
  // Japan SKUs, the code master for the internal SKUs France, the UK and Group
  // order under (sku-model.ts). The model chosen under BOM wins for the costing.
  const [{ data: catalog }, { data: master }, hub] = await Promise.all([
    ops.from('po_product_catalog').select('sku, bom_model_code'),
    ops.from('product_code_master').select('internal_sku, bom_model_code'),
    loadHubBomChoices(),
  ])
  const maps = modelMaps(
    (catalog ?? []) as { sku: string; bom_model_code: string | null }[],
    (master ?? []) as { internal_sku: string; bom_model_code: string | null }[],
  )
  const skus = [...new Set(pos.flatMap((p) => (p.lines ?? []).map((l) => l.sku)))]
  const skuModels = new Map<string, LineModels>(
    skus.map((sku) => [sku, lineModels(sku, maps.catalogue, maps.master, hub.chosen)]),
  )
  const week = await latestWeek(mfg)
  const priceMap = await loadMaterialPriceMap(mfg)
  const bomByModel = new Map<string, MfgBomRow>()
  if (week) {
    const models = [...new Set([...skuModels.values()].map((m) => m.bomModel).filter((m): m is string => Boolean(m)))]
    if (models.length) {
      const { data: boms } = await mfg
        .from('bom_weekly_snapshot')
        .select('model_code, component_detail, bamida_man_eur, bamida_print_eur, sro_admin_eur')
        .eq('week_start_date', week)
        .in('model_code', models)
      for (const b of (boms ?? []) as MfgBomRow[]) bomByModel.set(b.model_code, b)
    }
  }
  return { ctx: { skuModels, bomByModel, priceMap, hubPrices: hub.prices }, week }
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
      'id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, status, cost_snapshot, cost_snapshot_at, lines:purchase_order_lines(sku, product_name, quantity)'
    )
    .eq('leg', 'EB_GROUP_TO_SRO')
    // 'approved' alone used to be right, when the SRO leg never left that
    // status. It does now: choosing to manufacture moves it to
    // in_manufacturing, and an order being built is exactly the one whose bill
    // of materials people need to look at.
    .in('status', ['approved', 'in_manufacturing', 'ready_for_shipment'])
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
    const status = (po as { status: string }).status
    if (snap) {
      return { ...(snap as SroPoBom), cost_frozen: true, cost_snapshot_at: (po as { cost_snapshot_at?: string | null }).cost_snapshot_at ?? null, status }
    }
    return { ...explodePo(po as unknown as PoForExplode, ctx as ExplodeCtx), status }
  })
  return { pos: out, week }
}

/**
 * The manufacturing order raised under each of these SRO orders, keyed by the
 * SRO order's id.
 *
 * The Bamida document is numbered after that child (EBSRO8001-1 under
 * EBGRP8001), and only orders being manufactured have one: an SRO order
 * fulfilled from stock has no manufacturing child and never will. So this is a
 * lookup rather than a field on SroPoBom, which for most orders is read back
 * out of a cost_snapshot written long before the numbering scheme existed.
 */
export async function loadManufacturingPoNumbers(sroPoIds: string[]): Promise<Record<string, string>> {
  if (sroPoIds.length === 0) return {}
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('parent_po_id, po_number')
    .eq('leg', 'SRO_TO_SUPPLIER')
    .in('parent_po_id', sroPoIds)
  // A failure here is not fatal (the document falls back to the SRO order's own
  // number) but it is silent on screen, so it has to be loud in the log.
  if (error) console.error('Could not read the manufacturing order numbers for these SRO orders:', error.message)

  const out: Record<string, string> = {}
  for (const row of (data ?? []) as { parent_po_id: string | null; po_number: string | null }[]) {
    if (row.parent_po_id && row.po_number) out[row.parent_po_id] = row.po_number
  }
  return out
}

/**
 * One SRO order's BOM, for the Bamida document that gets emailed.
 *
 * The frozen cost_snapshot is authoritative and is what almost every order
 * carries, so this is usually a single row read with no manufacturing round
 * trip. Only an order predating the snapshot column needs a live explosion, and
 * that path is the same one loadSroPoBoms uses.
 *
 * Pass a client to read as somebody other than the caller: the factory's
 * download action hands in the service-role client after its own gate, because
 * that account holds none of the capabilities can_read_po() wants.
 */
export async function loadSroPoBom(
  poId: string,
  client?: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
): Promise<SroPoBom | null> {
  const supabase = client ?? (await createServerClient())
  const { data: po } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, cost_snapshot, cost_snapshot_at, lines:purchase_order_lines(sku, product_name, quantity)'
    )
    .eq('id', poId)
    .maybeSingle()
  if (!po) return null

  const snap = (po as { cost_snapshot?: unknown }).cost_snapshot
  if (snap) {
    return {
      ...(snap as SroPoBom),
      cost_frozen: true,
      cost_snapshot_at: (po as { cost_snapshot_at?: string | null }).cost_snapshot_at ?? null,
    }
  }

  if (!mfgConfigured()) return null
  const { ctx } = await buildExplodeCtx(supabase, createMfgClient(), [po as unknown as PoForExplode])
  return explodePo(po as unknown as PoForExplode, ctx)
}

/**
 * Freeze the exploded SRO cost onto a PO at approval (authoritative — it then
 * drives the record and the Xero PO instead of floating with material_prices).
 * Best-effort: swallows errors so a mfg hiccup never blocks an approval.
 */
export async function snapshotSroPoCost(poId: string): Promise<{ ok: boolean; sro_total?: number }> {
  try {
    const snap = await freezeSroPoCost(poId)
    return { ok: true, sro_total: snap.sro_total }
  } catch (e) {
    console.error('snapshotSroPoCost failed', poId, e)
    return { ok: false }
  }
}

/**
 * Explode one SRO order from today's bill of materials and write it as the
 * frozen cost. Throws on any failure, including a write that matched no row.
 * `whileStatus` makes the write conditional, so an order that moved on in the
 * meantime keeps the cost it had.
 */
async function freezeSroPoCost(poId: string, whileStatus?: string): Promise<SroPoBom> {
  if (!mfgConfigured()) throw new Error('Manufacturing data source not configured (MFG_SUPABASE_* env).')
  const admin = createAdminClient()
  const { data: po, error } = await admin
    .from('purchase_orders')
    .select('id, po_number, master_ref, from_entity, to_entity, approved_at, created_at, lines:purchase_order_lines(sku, product_name, quantity)')
    .eq('id', poId)
    .maybeSingle()
  if (error) throw new Error(`Could not read the order: ${error.message}`)
  if (!po) throw new Error('No such order.')
  const { ctx } = await buildExplodeCtx(
    admin as unknown as Parameters<typeof buildExplodeCtx>[0],
    createMfgClient(),
    [po as unknown as PoForExplode]
  )
  const snap = explodePo(po as unknown as PoForExplode, ctx)
  let write = admin
    .from('purchase_orders')
    .update({ cost_snapshot: snap, sro_cost_snapshot_eur: snap.sro_total, cost_snapshot_at: new Date().toISOString() })
    .eq('id', poId)
  if (whileStatus) write = write.eq('status', whileStatus)
  const { data: written, error: writeError } = await write.select('id')
  if (writeError) throw new Error(`Could not save the cost: ${writeError.message}`)
  if (!written?.length) throw new Error('The order moved on before its cost was saved.')
  return snap
}

export type RecostResult =
  | { ok: true; poNumber: string; before: SroPoBom | null; after: SroPoBom }
  | { ok: false; error: string }

/**
 * Freeze an SRO order's cost again from today's bill of materials, for an order
 * approved before its product had a bill of materials or before a price was
 * put right. Only while no manufacturing order has been raised under it: from
 * then on the -1 and the -3 are documents somebody works from, and the priced
 * order editor is where a price is changed.
 *
 * The caller gates. Nothing here reaches Xero, which was given the order's own
 * line prices at approval and never this cost.
 */
export async function recostSroPo(poId: string): Promise<RecostResult> {
  const admin = createAdminClient()
  const [order, children] = await Promise.all([
    admin
      .from('purchase_orders')
      .select('id, po_number, leg, status, cost_snapshot')
      .eq('id', poId)
      .maybeSingle<{ id: string; po_number: string; leg: string; status: string; cost_snapshot: SroPoBom | null }>(),
    admin.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('parent_po_id', poId).eq('leg', 'SRO_TO_SUPPLIER'),
  ])
  if (order.error || children.error) return { ok: false, error: 'Could not read the order.' }
  const po = order.data
  if (!po || po.leg !== 'EB_GROUP_TO_SRO') return { ok: false, error: 'That is not an order to the s.r.o.' }
  if (po.status !== 'approved') return { ok: false, error: `${po.po_number} is ${po.status.replace(/_/g, ' ')}, so its cost stays as it is.` }
  if ((children.count ?? 0) > 0) {
    return { ok: false, error: `A manufacturing order has been raised under ${po.po_number}, so its cost stays as it is. Change a price on its priced order instead.` }
  }
  try {
    const after = await freezeSroPoCost(poId, 'approved')
    return { ok: true, poNumber: po.po_number, before: po.cost_snapshot, after }
  } catch (e) {
    console.error('recostSroPo failed', poId, e)
    return { ok: false, error: e instanceof Error ? e.message : 'Could not re-cost the order.' }
  }
}

/** Master BOM rows for the latest week, PRICED from material_prices + a Δ vs the synced snapshot total. */
export async function loadBomMaster(): Promise<{ rows: BomMasterRow[]; week: string | null; error?: string }> {
  if (!mfgConfigured()) {
    return { rows: [], week: null, error: 'Manufacturing data source not configured (MFG_SUPABASE_* env).' }
  }
  let hub: Awaited<ReturnType<typeof loadHubBomChoices>>
  try {
    hub = await loadHubBomChoices()
  } catch (e) {
    console.error('loadBomMaster could not read the Hub prices', e)
    return { rows: [], week: null, error: 'Could not read the Bamida prices set in the Hub.' }
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
      const set = hub.prices.get(r.model_code)
      const { man, print, manFromHub, printFromHub } = bamidaLabour(r.bamida_man_eur, r.bamida_print_eur, set)
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
        sheet_man_eur: r.bamida_man_eur == null ? null : num(r.bamida_man_eur),
        sheet_print_eur: r.bamida_print_eur == null ? null : num(r.bamida_print_eur),
        hub_price: set ? { manufacturing: manFromHub, printing: printFromHub, by: set.by, at: set.at } : null,
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
