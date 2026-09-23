import 'server-only'

import type { XeroBillDraft } from '@/lib/customs/xero-bill'

/**
 * The one n8n webhook behind the Customs tab (medes, "Hub customs"). Three actions:
 *
 *  - ocr: n8n fetches the PDF from a short signed link, has Claude read it into
 *    customsPackageSchema, reads the Group bills it names from Xero, and posts the lot back to
 *    /api/customs/extraction. It answers at once; the reading arrives later.
 *  - create_draft: the bill as prefilled here becomes a DRAFT in Xero, Echo Barrier USA LLC, with
 *    the PDF attached. n8n first looks for a Nippon bill with that number already in Xero and
 *    returns it instead of making a second one.
 *  - authorise: Dave approved it in the Hub, so the draft is authorised in Xero.
 *
 * Header x-hub-secret, like every other webhook the Hub calls.
 */

export type CustomsWebhookAction =
  | { action: 'ocr'; bill_id: string; file_name: string; pdf_url: string }
  | { action: 'create_draft'; bill_id: string; bill: XeroBillDraft; file_name: string; pdf_url: string }
  | { action: 'authorise'; bill_id: string; xero_invoice_id: string }

export interface XeroBillLineOut {
  description: string
  amount: number
  accountCode: string | null
}

export type CustomsWebhookResult =
  | {
      ok: true
      xero_invoice_id?: string
      xero_status?: string
      /** A bill with this number was already in Xero, so nothing new was made. */
      existing?: boolean
      xero_lines?: XeroBillLineOut[]
    }
  | { ok: false; error: string }

export function customsWebhookConfigured(): boolean {
  return Boolean(process.env.N8N_CUSTOMS_WEBHOOK_URL)
}

export async function callCustomsWebhook(
  payload: CustomsWebhookAction,
  timeoutMs = 25_000,
): Promise<CustomsWebhookResult> {
  const url = process.env.N8N_CUSTOMS_WEBHOOK_URL
  if (!url) return { ok: false, error: 'The customs webhook is not configured on the server (N8N_CUSTOMS_WEBHOOK_URL).' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CUSTOMS_WEBHOOK_SECRET ? { 'x-hub-secret': process.env.N8N_CUSTOMS_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `n8n answered ${res.status}`
      return { ok: false, error: message }
    }
    if (!body || typeof body !== 'object') {
      // n8n answering 200 with nothing is how a broken workflow looks from here. Never a success.
      return { ok: false, error: 'n8n answered without a result.' }
    }
    const result = body as Record<string, unknown>
    if (result.ok === false) return { ok: false, error: String(result.error ?? 'n8n reported a failure.') }
    return {
      ok: true,
      xero_invoice_id: typeof result.xero_invoice_id === 'string' ? result.xero_invoice_id : undefined,
      xero_status: typeof result.xero_status === 'string' ? result.xero_status : undefined,
      existing: result.existing === true,
      xero_lines: Array.isArray(result.xero_lines) ? (result.xero_lines as XeroBillLineOut[]) : undefined,
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ok: false, error: aborted ? 'n8n did not answer in time.' : 'Could not reach n8n.' }
  } finally {
    clearTimeout(timer)
  }
}
