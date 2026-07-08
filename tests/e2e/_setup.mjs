// Ephemeral E2E fixtures for SRO slices 2–4. Creates two scoped test users
// (buyer + worker) and approved-PO DB fixtures DIRECTLY (skips approve→n8n→Xero),
// then writes tests/e2e/.e2e-state.json for the specs. Paired with _teardown.mjs.
//
//   node tests/e2e/_setup.mjs
//
// Uses the service-role key from .env.local. Everything it creates is removed by
// _teardown.mjs (and is clearly tagged 'E2E TEST FIXTURE' / e2e-*@echobarrier.eu).

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const env = {}
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const pw = () => 'E2e!' + randomBytes(9).toString('base64url')
const BUYER = { email: 'e2e-buyer@echobarrier.eu', password: pw() }
const WORKER = { email: 'e2e-worker@echobarrier.eu', password: pw() }

async function findUserId(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const u = data.users.find((x) => x.email === email)
    if (u) return u.id
    if (data.users.length < 1000) return null
  }
}

async function ensureUser(u, { depots, caps }) {
  let id
  const { data, error } = await sb.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true,
  })
  if (error) {
    if (!/registered|exists/i.test(error.message)) throw error
    id = await findUserId(u.email)
    if (!id) throw new Error('user exists but not found: ' + u.email)
    await sb.auth.admin.updateUserById(id, { password: u.password, email_confirm: true })
  } else {
    id = data.user.id
  }
  // profiles row is auto-created by the handle_new_user trigger.
  const { error: pe } = await sb
    .from('profiles')
    .update({ display_name: u.email.split('@')[0], is_super_admin: false, allowed_depots: depots })
    .eq('id', id)
  if (pe) throw pe
  await sb.from('user_capabilities').delete().eq('user_id', id)
  const { error: ce } = await sb
    .from('user_capabilities')
    .insert(caps.map((c) => ({ user_id: id, capability: c })))
  if (ce) throw ce
  return id
}

async function makePo(leg, from, to, lines) {
  const { data: po, error } = await sb
    .from('purchase_orders')
    .insert({
      leg,
      from_entity: from,
      to_entity: to,
      status: 'approved',
      source: 'hub',
      requested_by: 'E2E',
      approved_by: 'E2E',
      notes: 'E2E TEST FIXTURE',
    })
    .select('id, po_number, master_ref')
    .single()
  if (error) throw error
  const { error: le } = await sb
    .from('purchase_order_lines')
    .insert(lines.map((l) => ({ po_id: po.id, ...l })))
  if (le) throw le
  return po
}

const buyerId = await ensureUser(BUYER, {
  depots: ['ALL'],
  caps: ['po.view', 'po.create', 'po.receive', 'bom.view', 'bom.edit', 'cost.view', 'quotes.view', 'transport.view', 'invoice.view', 'invoice.create'],
})
const workerId = await ensureUser(WORKER, {
  depots: null,
  caps: ['po.view', 'po.receive', 'bom.view', 'invoice.view'],
})

// Fixture A — depot leg, for the receiving flow (skips approve→Xero).
const receivePo = await makePo('DEPOT_TO_EB_GROUP', 'US-BAL', 'EB-GROUP', [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 10 },
  { sku: 'EBH10NA', product_name: 'Echo Barrier H10', product_family: 'H10', quantity: 5 },
])
// Fixture B — group→SRO leg with a barrier SKU, for the BOM explosion + Bamida PO.
const bomPo = await makePo('EB_GROUP_TO_SRO', 'EB-GROUP', 'EB-SRO', [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 20 },
])

// Fixture B2 — an SRO order with a FROZEN cost snapshot (cost frozen at approval).
// The frozen SRO total is a distinctive value a live explosion could never produce,
// so if the BOM page shows it, the frozen snapshot (not a re-explosion) was used.
const FROZEN_SRO = 4242.42
const frozenPo = await makePo('EB_GROUP_TO_SRO', 'EB-GROUP', 'EB-SRO', [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 1 },
])
await sb
  .from('purchase_orders')
  .update({
    cost_snapshot: {
      id: frozenPo.id,
      po_number: frozenPo.po_number,
      master_ref: frozenPo.master_ref,
      from_entity: 'EB-GROUP',
      to_entity: 'EB-SRO',
      approved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      lines: [
        {
          sku: 'EBH9NA',
          product_name: 'Echo Barrier H9',
          quantity: 1,
          model_code: null,
          has_bom: false,
          components: [],
          bamida_man_eur: 0,
          bamida_print_eur: 0,
          components_eur_unit: 0,
          bamida_total_line: 0,
          sro_total_line: FROZEN_SRO,
        },
      ],
      bamida_total: 0,
      sro_total: FROZEN_SRO,
    },
    sro_cost_snapshot_eur: FROZEN_SRO,
    cost_snapshot_at: new Date().toISOString(),
  })
  .eq('id', frozenPo.id)

// Fixture C — for the Cargo SPOT-ID AUTO-DETECT test: force its po_number to a
// reference Cargo Partner actually holds (PO-00001364 → SPOT 240362822), since
// Hub-minted PO numbers don't match Cargo's references.
const cargoPo = await makePo('DEPOT_TO_EB_GROUP', 'US-BAL', 'EB-GROUP', [
  { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 8 },
])
await sb.from('purchase_orders').update({ po_number: 'PO-00001364' }).eq('id', cargoPo.id)
cargoPo.po_number = 'PO-00001364'

// Fixture D — a container in shipment_contents for the commercial-invoice test
// (EBH9NA has a seeded transfer price of €27.01, so 10 → €270.10).
await sb.from('shipment_contents').delete().eq('container_ref', 'E2EINV1')
// Clear both the generation container (E2EINV1) and the seeded-list container
// (E2EINV0) — a prior generation leaves a real invoice that the new duplicate
// guard would otherwise collide with on re-run.
await sb.from('commercial_invoices').delete().in('container_ref', ['E2EINV1', 'E2EINV0'])
await sb.from('shipment_contents').insert({
  spot_id: 'E2ETESTSPOT',
  container_ref: 'E2EINV1',
  sku: 'EBH9NA',
  product_name: 'Echo Barrier H9',
  qty: 10,
  depot_destination: 'US-BAL',
  status: 'at_port',
  po_reference: 'E2E-PO',
})

// A persisted commercial invoice (for the /invoices list + cost-strip test).
const invFix = await sb
  .from('commercial_invoices')
  .insert({
    invoice_number: 'EBGS-E2E-0001',
    leg: 'SRO_TO_GROUP',
    seller_entity_code: 'EB-SRO',
    buyer_entity_code: 'EB-GROUP',
    shipment_spot_id: 'E2ETESTSPOT',
    container_ref: 'E2EINV0',
    po_reference: 'E2E-PO',
    currency: 'EUR',
    subtotal: 270.1,
    tax_total: 0,
    total: 270.1,
    status: 'draft',
  })
  .select('id')
  .single()
if (invFix.error) throw invFix.error
await sb.from('commercial_invoice_lines').insert({
  invoice_id: invFix.data.id,
  sku: 'EBH9NA',
  product_name: 'Echo Barrier H9',
  qty: 10,
  unit_value: 27.01,
  line_total: 270.1,
  container_ref: 'E2EINV0',
  sort_order: 0,
})

writeFileSync(
  resolve(process.cwd(), 'tests/e2e/.e2e-state.json'),
  JSON.stringify({ buyer: BUYER, worker: WORKER, buyerId, workerId, receivePo, bomPo, cargoPo }, null, 2)
)

console.log('E2E setup OK')
console.log('  buyer :', BUYER.email, '— po.view,po.create,po.receive,bom.view,cost.view')
console.log('  worker:', WORKER.email, '— po.view,po.receive,bom.view (NO cost.view)')
console.log('  receive fixture:', receivePo.po_number, receivePo.master_ref)
console.log('  BOM fixture    :', bomPo.po_number, bomPo.master_ref)
console.log('  cargo fixture  :', cargoPo.po_number, '(forced → Cargo SPOT 240362822)')
