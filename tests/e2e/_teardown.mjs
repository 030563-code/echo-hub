// Removes everything _setup.mjs created (users + PO fixtures + E2E templates).
//   node tests/e2e/_teardown.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const env = {}
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const statePath = resolve(process.cwd(), 'tests/e2e/.e2e-state.json')
const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}

// Remove any attachment objects under the fixture POs (storage isn't FK'd).
for (const po of [s.receivePo, s.bomPo]) {
  if (!po?.id) continue
  const { data: objs } = await sb.storage.from('po-attachments').list(po.id)
  if (objs?.length) {
    await sb.storage.from('po-attachments').remove(objs.map((o) => `${po.id}/${o.name}`))
  }
}

// PO fixtures (CASCADE removes lines + receipts + attachment rows). By tag too.
for (const po of [s.receivePo, s.bomPo]) {
  if (po?.id) await sb.from('purchase_orders').delete().eq('id', po.id)
}
await sb.from('purchase_orders').delete().eq('notes', 'E2E TEST FIXTURE')

// Templates created by the run.
await sb.from('po_templates').delete().ilike('name', 'E2E%')

// Commercial-invoice fixture: any invoices produced (CASCADE removes lines) + the
// shipment_contents container row.
await sb.from('commercial_invoices').delete().in('container_ref', ['E2EINV1', 'E2EINV0'])
await sb.from('shipment_contents').delete().eq('container_ref', 'E2EINV1')

// Restore mfg material_prices to the snapshot baseline — undoes the BOM material
// edit the suite makes (and any stray edits), so prod prices are left as-was.
if (env.MFG_SUPABASE_URL && env.MFG_SUPABASE_SERVICE_ROLE_KEY) {
  const mfg = createClient(env.MFG_SUPABASE_URL, env.MFG_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: wk } = await mfg
    .from('bom_weekly_snapshot')
    .select('week_start_date')
    .order('week_start_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (wk?.week_start_date) {
    const { data: rows } = await mfg
      .from('bom_weekly_snapshot')
      .select('component_detail')
      .eq('week_start_date', wk.week_start_date)
    const baseline = new Map()
    for (const r of rows ?? []) {
      for (const c of r.component_detail ?? []) {
        if (!c?.code) continue
        const p = Number(c.unit_cost_eur)
        if (Number.isFinite(p)) baseline.set(c.code, Math.max(baseline.get(c.code) ?? -Infinity, p))
      }
    }
    for (const [code, price] of baseline) {
      await mfg.from('material_prices').update({ unit_price_eur: price }).eq('material_code', code)
    }
    // Clear the audit label left by the test edit (back to the seeded null state).
    await mfg.from('material_prices').update({ updated_by_uid: null, updated_by_label: null }).like('updated_by_label', 'e2e-%')
  }
}

// Test users (+ their grants/profile).
for (const id of [s.buyerId, s.workerId]) {
  if (!id) continue
  await sb.from('user_capabilities').delete().eq('user_id', id)
  await sb.from('profiles').delete().eq('id', id)
  await sb.auth.admin.deleteUser(id)
}

if (existsSync(statePath)) rmSync(statePath)
console.log('E2E teardown OK')
