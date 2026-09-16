import 'server-only'

/**
 * Put the Hub's purchase order PDF onto the matching Xero purchase order.
 *
 * Dean, 16 Sep 2026, having added the attachments scope to the Xero Try
 * credential: "is it possible to attach the Purchase order pdf in Xero the same
 * way we do it with the invoicing", then "Make sure you dont reput the POs into
 * Xero."
 *
 * So this NEVER creates a purchase order. It renders bytes and hands them to a
 * webhook whose only Xero call is
 * PUT /PurchaseOrders/{PurchaseOrderID}/Attachments/{FileName}
 * (Xero's own spec: PUT creates the attachment, POST updates an existing one).
 * The purchase order must already exist and its id must already be on the Hub
 * row, written back by the workflow that created it. Nothing here can mint one.
 *
 * Same shape as the invoice attachment in send-to-xero.ts: rendered server-side,
 * sent as base64 rather than a signed URL, because this is a server-to-server
 * post and not a client action payload.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { getPoPdfData } from '@/lib/po-pdf-data'
import { buildPoPdf, poPdfFilename } from '@/lib/po-pdf'
import { serverLogoDataUrl } from '@/lib/pdf-logo.server'
import { entityPoCurrency } from '@/lib/po-currency'
import { externalCallsDisabled } from '@/lib/env'
import type { PurchaseOrder } from '@/lib/erp-types'

const TIMEOUT_MS = 30_000

export type AttachResult =
  | { ok: true; filename: string; bytes: number }
  | { ok: false; error: string }

/**
 * Render the purchase order exactly as the Download PDF button does.
 *
 * PRICED, always. This document goes onto the accounting ledger, where the
 * figures are the point; the cost.view rule exists to keep prices off screens,
 * not off the books. The caller gates who may do this.
 */
export async function renderPoPdfForXero(
  po: PurchaseOrder,
): Promise<{ filename: string; base64: string }> {
  const admin = createAdminClient()
  const pdfData = await getPoPdfData(admin)

  // The cost is entered on the ROOT (depot) leg in that depot's currency and the
  // document converts into this leg's, so the rate comes from the root. Same
  // rule the board and the single order page use.
  let rootFrom = po.from_entity
  let cursor: string | null = po.parent_po_id ?? null
  while (cursor) {
    const { data: parent } = await admin
      .from('purchase_orders')
      .select('from_entity, parent_po_id')
      .eq('id', cursor)
      .maybeSingle<{ from_entity: string | null; parent_po_id: string | null }>()
    if (!parent) break
    if (parent.from_entity) rootFrom = parent.from_entity
    cursor = parent.parent_po_id
  }

  const doc = await buildPoPdf(po, {
    canViewCost: true,
    parties: pdfData.parties,
    fx: pdfData.fx,
    rootCurrency: entityPoCurrency(rootFrom),
    logoDataUrl: await serverLogoDataUrl(),
  })

  const bytes = Buffer.from(doc.output('arraybuffer'))
  return { filename: poPdfFilename(po), base64: bytes.toString('base64') }
}

/**
 * Hand the bytes to n8n, which owns the Xero credential.
 *
 * Xero is reached through n8n by standing instruction, never from the Hub.
 */
export async function attachPoPdfToXero(po: PurchaseOrder): Promise<AttachResult> {
  if (externalCallsDisabled()) {
    return { ok: false, error: 'Sandbox (staging): nothing is sent to Xero from here.' }
  }
  if (!po.xero_po_id || !po.xero_tenant_id) {
    return {
      ok: false,
      error: 'This order has no Xero purchase order recorded yet, so there is nothing to attach it to.',
    }
  }

  const webhookUrl = String(process.env.N8N_XERO_PO_ATTACH_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) {
    return { ok: false, error: 'The Xero attachment webhook is not configured on the server.' }
  }

  const { filename, base64 } = await renderPoPdfForXero(po)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_XERO_PO_ATTACH_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_XERO_PO_ATTACH_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify({
        action: 'attach_po_pdf',
        po_id: po.id,
        po_number: po.po_number,
        /** Which Xero organisation. Picked by the Hub, never guessed in n8n. */
        xero_tenant_id: po.xero_tenant_id,
        /** The purchase order that ALREADY exists. Nothing creates one. */
        xero_po_id: po.xero_po_id,
        filename,
        content_base64: base64,
      }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('attachPoPdfToXero failed', res.status, detail.slice(0, 300))
      return { ok: false, error: `Xero did not accept the attachment (HTTP ${res.status}).` }
    }
    return { ok: true, filename, bytes: Buffer.from(base64, 'base64').length }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? 'The Xero attachment workflow did not respond in time.' : 'The Xero attachment workflow could not be reached.',
    }
  } finally {
    clearTimeout(timer)
  }
}
