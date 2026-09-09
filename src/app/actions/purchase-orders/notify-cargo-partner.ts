import 'server-only'

/**
 * Tell Cargo Partner a container is ready to collect from Bamida.
 *
 * Not a 'use server' file. Only the action modules are; every export of one is
 * a callable endpoint, and this has no business being one.
 *
 * Dean's brief, 8 Sep 2026: when Bamida press "Manufacturing finished", the Hub
 * raises the transport order and emails Cargo Partner with Juraj in copy. This
 * is the EMAIL half only. It makes no API call to Cargo Partner, by standing
 * instruction: no transport order, document or event is ever written to their
 * system, on production or test, without Dean saying yes to that specific call.
 * An email a person reads and acts on is a different thing from a booking the
 * Hub creates behind their back, and it is the half that takes Juraj out of the
 * loop today.
 *
 * The body carries the shipping details a forwarder actually needs to open an
 * order: the reference they will index it under, where it is collected from,
 * where it is going, when it is ready, and how many pallets of what.
 *
 * The Hub decides who receives it and n8n owns the wording, the same split as
 * the SRO and Bamida emails. A workflow holding its own copy of an address list
 * would mail a forwarder while the Hub believed everything was going to Dean.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients, type ResolvedRecipients } from '@/lib/email-recipients'

const TIMEOUT_MS = 15_000

/** Barriers per pallet. Same figure the Bamida purchase order is built on. */
const PALLET_SIZE = 70

/**
 * The parties, as they are recorded against real shipments in
 * `shipments.shipment_details -> participants`. Account numbers are what Cargo
 * Partner index on, so they matter more than the addresses.
 *
 * Deliberately constants rather than a lookup: they are three fixed commercial
 * relationships, and a query here would be a query that can fail on the one
 * path that must not fail, the finished button.
 */
const SHIPPER = {
  name: 'Echo Barrier s.r.o.',
  account: '446813',
  address: ['Sturova 3/6', '040 01 Kosice', 'Slovakia'],
} as const

const PICKUP = {
  name: 'BAMIDA, s.r.o.',
  account: '604070',
  address: ['Kosicka 28', '080 01 Presov', 'Slovakia'],
} as const

const OFFICE_IN_CHARGE = {
  name: 'cargo-partner SR, Kosice',
  account: '139461',
  role: 'CONTROLLING_AGENT',
} as const

/** Juraj sees every one of these, by Dean's instruction. */
const DEFAULT_CC = 'juraj@echobarrier.eu'

export type CargoLine = {
  sku: string | null
  product_name: string | null
  product_family: string | null
  quantity: number | null
}

export type NotifyCargoInput = {
  /** The SRO to Bamida order. Its number is the reference Cargo Partner index on. */
  poId: string
  poNumber: string | null
  masterRef: string | null
  /** When Bamida said the barriers were ready. This is the cargo readiness date. */
  finishedAt: string
  lines: CargoLine[]
}

export type NotifyCargoResult =
  | { sent: true; recipients: ResolvedRecipients }
  | { sent: false; reason: 'not_configured' | 'staging' | 'failed' }

/** Pallets, rounded up per product family. A part pallet still takes a pallet. */
export function palletsFor(lines: CargoLine[]): number {
  let pallets = 0
  for (const l of lines) {
    const qty = Number(l.quantity ?? 0)
    if (qty > 0) pallets += Math.ceil(qty / PALLET_SIZE)
  }
  return pallets
}

/** "Acoustic Barriers H9, H10", or just "Acoustic Barriers" when nothing is named. */
export function cargoDescription(lines: CargoLine[]): string {
  const models = Array.from(
    new Set(lines.map((l) => (l.product_family ?? '').trim()).filter(Boolean)),
  ).sort()
  return models.length ? `Acoustic Barriers ${models.join(', ')}` : 'Acoustic Barriers'
}

/**
 * Where the container is going: the depot that started the chain.
 *
 * The Bamida order's parent is the SRO leg and its parent is the depot leg, so
 * the destination is two steps up. Returns nulls rather than throwing, because
 * an unknown consignee is worth an email that says so; it is not worth losing
 * the notification that a container is ready.
 */
async function resolveConsignee(poId: string): Promise<{ depot: string | null; address: string | null }> {
  const admin = createAdminClient()
  const { data: bamidaPo } = await admin
    .from('purchase_orders')
    .select('parent_po_id')
    .eq('id', poId)
    .maybeSingle<{ parent_po_id: string | null }>()
  if (!bamidaPo?.parent_po_id) return { depot: null, address: null }

  const { data: sroLeg } = await admin
    .from('purchase_orders')
    .select('parent_po_id, delivery_address')
    .eq('id', bamidaPo.parent_po_id)
    .maybeSingle<{ parent_po_id: string | null; delivery_address: string | null }>()
  if (!sroLeg?.parent_po_id) return { depot: null, address: sroLeg?.delivery_address ?? null }

  const { data: groupLeg } = await admin
    .from('purchase_orders')
    .select('parent_po_id, from_entity, delivery_address')
    .eq('id', sroLeg.parent_po_id)
    .maybeSingle<{ parent_po_id: string | null; from_entity: string | null; delivery_address: string | null }>()
  if (!groupLeg) return { depot: null, address: sroLeg.delivery_address ?? null }

  // The depot leg is the root; its from_entity is the depot that ordered.
  if (groupLeg.parent_po_id) {
    const { data: depotLeg } = await admin
      .from('purchase_orders')
      .select('from_entity, delivery_address')
      .eq('id', groupLeg.parent_po_id)
      .maybeSingle<{ from_entity: string | null; delivery_address: string | null }>()
    if (depotLeg) {
      return {
        depot: depotLeg.from_entity ?? null,
        address: depotLeg.delivery_address ?? groupLeg.delivery_address ?? sroLeg.delivery_address ?? null,
      }
    }
  }
  return {
    depot: groupLeg.from_entity ?? null,
    address: groupLeg.delivery_address ?? sroLeg.delivery_address ?? null,
  }
}

/**
 * Best effort. The finished timestamp is already written when this runs, so a
 * mail failure is something to report, never a reason to un-finish an order
 * Bamida have finished.
 */
export async function notifyCargoPartnerReady(input: NotifyCargoInput): Promise<NotifyCargoResult> {
  if (externalCallsDisabled()) return { sent: false, reason: 'staging' }

  const webhookUrl = String(process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) return { sent: false, reason: 'not_configured' }

  // No default recipient on purpose. Cargo Partner's booking address is not
  // recorded anywhere in the Hub, and guessing a forwarder's inbox is not a
  // thing to do. Until it is configured this stays silent.
  const to = String(process.env.CARGO_NOTIFY_TO ?? '').trim()
  if (!to) return { sent: false, reason: 'not_configured' }

  const recipients = resolveRecipients({
    to,
    cc: String(process.env.CARGO_NOTIFY_CC ?? '').trim() || DEFAULT_CC,
  })

  const consignee = await resolveConsignee(input.poId)
  const payload = buildCargoNotifyPayload(input, recipients, consignee)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { sent: false, reason: 'failed' }
    return { sent: true, recipients }
  } catch {
    return { sent: false, reason: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Split out so the payload can be asserted in a unit test without a network.
 * Exported for the tests; nothing else should call it.
 */
export function buildCargoNotifyPayload(
  input: NotifyCargoInput,
  recipients: ResolvedRecipients,
  consignee: { depot: string | null; address: string | null },
) {
  const pallets = palletsFor(input.lines)
  const readiness = input.finishedAt.slice(0, 10)
  return {
    action: 'cargo_collection_ready',
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    is_test: recipients.isTest,
    /** Who it would have reached. n8n prints this in the body of a test send. */
    intended: recipients.intended,

    po_id: input.poId,
    po_number: input.poNumber,
    master_ref: input.masterRef,

    shipment: {
      /** The key Cargo Partner index on, and the one the SPOT lookup searches. */
      general_reference: input.poNumber,
      main_modality: 'SEA',
      main_category: 'FCL',
      business_direction: 'EXPORT',
      /**
       * The Incoterm on the SRO to depot leg is recorded nowhere in the Hub and
       * is Juraj's to give. Null, and the email asks for it, rather than an
       * invented term that quietly decides who pays for freight.
       */
      delivery_term: null,
      cargo_readiness_date: readiness,
      pieces: pallets,
      package_type_code: 'PAL',
      description: cargoDescription(input.lines),
    },

    participants: {
      shipper: SHIPPER,
      principal: SHIPPER,
      main_invoice_to: SHIPPER,
      pickup: PICKUP,
      consignee: {
        depot: consignee.depot,
        address: consignee.address,
      },
      office_in_charge: OFFICE_IN_CHARGE,
    },

    lines: input.lines.map((line) => ({
      sku: line.sku,
      product_name: line.product_name,
      product_family: line.product_family,
      quantity: line.quantity,
      pallets: line.quantity ? Math.ceil(Number(line.quantity) / PALLET_SIZE) : 0,
    })),

    link: `${hubBaseUrl()}/purchase-orders/${input.poId}`,
  }
}
