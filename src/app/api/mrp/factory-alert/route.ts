import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { bearerAuthorized } from '@/lib/machine-auth'
import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients } from '@/lib/email-recipients'
import { readyNotifyRecipients } from '@/app/actions/purchase-orders/notify-ready-for-shipment'
import { loadSendContacts } from '@/lib/send-contacts'
import { feedIsFrozen } from '@/lib/factory/status'
import type { BomComponentRow, BomProductRow } from '@/lib/mrp/materials'
import {
  alertSignature,
  anythingShort,
  materialNeeds,
  productCapabilities,
  type CapabilityStatusRow,
  type SkuMapRow,
} from '@/lib/factory/capability-math'

// ---------------------------------------------------------------------------
// POST /api/mrp/factory-alert — tell the factory when our requirement exceeds
// what their materials allow. Called by the MRP Nightly right after the engine
// run, so it reads the rows that run just wrote.
//
// Bamida's CEO, 18 Sep 2026: "It is crucial for the system to be able to alert
// the warehouse when the stock of any material runs low. Only you can configure
// this." The minimum is our forecast: a product is short when the engine's
// action quantity exceeds max_buildable, and a material is short when the
// requirement, exploded through the bill of materials, exceeds the shelf.
//
// Three refusals, each reported rather than silent:
//   feed_frozen    their stock feed has not moved in a week, so any figure
//                  computed from it is a false alarm or a false all-clear;
//   nothing_short  a quiet day;
//   already_sent   the same picture was mailed before. One alert per change,
//                  keyed on a hash of what it says, so it is never a daily nag.
//
// Auth is the same machine secret as /api/mrp/run and fails closed. ?dry_run=1
// returns the payload without sending or recording, which is how it is checked.
// The email itself goes out through the manufacturing webhook the order and
// confirmation emails already use; n8n picks the wording off `action`.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000

type StockRow = {
  ns_number: string
  item_name: string
  unit: string | null
  quantity: number | null
  last_changed_at: string | null
}

export async function POST(request: Request) {
  if (!bearerAuthorized(request.headers.get('authorization'), process.env.MRP_CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1'

  try {
    const admin = createAdminClient()

    const [{ data: stockRows }, { data: mapRows }] = await Promise.all([
      admin
        .from('bamida_material_stock')
        .select('ns_number, item_name, unit, quantity, last_changed_at')
        .eq('is_active', true),
      admin.from('mrp_bom_sku_map').select('hub_sku, fg_code, confirmed'),
    ])
    const stock = (stockRows ?? []) as StockRow[]
    const skuMap = (mapRows ?? []) as SkuMapRow[]

    const newestChangeAt = stock.reduce<string | null>(
      (acc, r) => (r.last_changed_at && (acc === null || r.last_changed_at > acc) ? r.last_changed_at : acc),
      null,
    )
    if (stock.length === 0 || feedIsFrozen(newestChangeAt)) {
      return NextResponse.json({ sent: false, reason: 'feed_frozen', feed_changed_at: newestChangeAt })
    }
    if (skuMap.length === 0) return NextResponse.json({ sent: false, reason: 'no_bom' })

    const hubSkus = skuMap.map((m) => m.hub_sku)
    const fgCodes = Array.from(new Set(skuMap.map((m) => m.fg_code)))
    const { data: latest } = await admin
      .from('mrp_buffer_status_daily')
      .select('run_date')
      .in('sku', hubSkus)
      .order('run_date', { ascending: false })
      .limit(1)
      .maybeSingle<{ run_date: string }>()
    if (!latest?.run_date) return NextResponse.json({ sent: false, reason: 'no_run' })

    const [{ data: statusRows }, { data: bomProducts }, { data: components }, { data: catalog }] =
      await Promise.all([
        admin
          .from('mrp_buffer_status_daily')
          .select(
            'sku, run_date, max_buildable, materials_binding_code, materials_binding_desc, action_qty, firm_demand, qualified_spikes, on_hand, in_transit, on_order, flags',
          )
          .eq('run_date', latest.run_date)
          .in('sku', hubSkus),
        admin.from('mrp_bom_product').select('fg_code, pallet_size').in('fg_code', fgCodes),
        admin
          .from('mrp_bom_component')
          .select('fg_code, component_code, component_desc, qty, basis, line_type, is_gating')
          .in('fg_code', fgCodes),
        admin.from('po_product_catalog').select('sku, product_name').in('sku', hubSkus),
      ])

    const names = new Map<string, string>()
    for (const c of (catalog ?? []) as { sku: string; product_name: string | null }[]) {
      if (c.product_name) names.set(c.sku, c.product_name)
    }
    const stockByCode = new Map(stock.map((s) => [s.ns_number, Math.max(0, Number(s.quantity ?? 0))]))
    const stockRow = new Map(stock.map((s) => [s.ns_number, s]))

    const products = productCapabilities(
      (statusRows ?? []) as unknown as CapabilityStatusRow[],
      skuMap,
      names,
    )
    const needs = materialNeeds(
      products,
      skuMap,
      (bomProducts ?? []) as BomProductRow[],
      (components ?? []) as BomComponentRow[],
      stockByCode,
    )

    const shortProducts = products.filter((p) => p.short)
    const shortMaterials = Array.from(needs.entries())
      .filter(([, n]) => n.short > 0)
      .map(([code, n]) => ({
        code,
        item_name: stockRow.get(code)?.item_name ?? code,
        unit: stockRow.get(code)?.unit ?? null,
        needed: Math.ceil(n.needed),
        have: n.have,
        short: Math.ceil(n.short),
        products: n.products,
      }))
      .sort((a, b) => b.short - a.short)

    if (!anythingShort(products, needs)) {
      return NextResponse.json({ sent: false, reason: 'nothing_short', run_date: latest.run_date })
    }

    const signature = alertSignature(products, needs)
    const fingerprint = createHash('sha256').update(signature).digest('hex')

    // Who at the factory. The same book the purchase order is addressed from:
    // required contacts always, plus the ones ticked by default. Never a
    // hard-coded address here.
    const book = await loadSendContacts('manufacturing')
    const pick = (field: 'to' | 'cc') =>
      book.filter((c) => c.field === field && (c.isRequired || c.defaultSelected)).map((c) => c.address)
    const internal = readyNotifyRecipients()
    const recipients = resolveRecipients({
      to: pick('to').join(', '),
      cc: [...pick('cc'), internal.to, internal.cc].filter(Boolean).join(', '),
    })

    const payload = {
      action: 'factory_stock_alert',
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      is_test: recipients.isTest,
      intended: recipients.intended,
      run_date: latest.run_date,
      feed_changed_at: newestChangeAt,
      products: shortProducts.map((p) => ({
        product_name: p.productName,
        requirement: p.requirement,
        max_buildable: p.maxBuildable,
        capped_by: p.bindingDesc ?? p.bindingCode,
        provisional: p.provisional,
      })),
      materials: shortMaterials,
      link: `${hubBaseUrl()}/factory/stock`,
    }

    if (dryRun) {
      return NextResponse.json({ sent: false, reason: 'dry_run', fingerprint, payload })
    }

    const { data: seen } = await admin
      .from('factory_stock_alerts')
      .select('first_sent_at')
      .eq('fingerprint', fingerprint)
      .maybeSingle<{ first_sent_at: string }>()
    if (seen) {
      return NextResponse.json({ sent: false, reason: 'already_sent', fingerprint, first_sent_at: seen.first_sent_at })
    }

    if (externalCallsDisabled()) return NextResponse.json({ sent: false, reason: 'staging', fingerprint })
    const webhookUrl = String(process.env.N8N_BAMIDA_PO_WEBHOOK_URL ?? '').trim()
    if (!webhookUrl) return NextResponse.json({ sent: false, reason: 'not_configured', fingerprint })
    if (recipients.to.length === 0) return NextResponse.json({ sent: false, reason: 'no_recipient', fingerprint })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET
            ? { 'x-hub-secret': process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!res.ok) return NextResponse.json({ sent: false, reason: 'failed', status: res.status, fingerprint })
    } finally {
      clearTimeout(timer)
    }

    // Recorded only after the send, so a failed send is retried tomorrow.
    await admin.from('factory_stock_alerts').insert({ fingerprint, payload })
    return NextResponse.json({
      sent: true,
      fingerprint,
      is_test: recipients.isTest,
      products_short: shortProducts.length,
      materials_short: shortMaterials.length,
    })
  } catch (e) {
    console.error('factory alert failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'factory alert failed' }, { status: 500 })
  }
}
