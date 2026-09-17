'use server'

/**
 * The supplier purchase order document, for the office.
 *
 * Dean, 17 Sep 2026: "the PO that is from SRO to BAMIDA should have the format
 * that is currently in the Bill Of Materials Bamida PO." The manufacturer has
 * always downloaded that document from their own tab; this is the same bytes
 * from the same builder, so the order page and the factory are never looking at
 * two different pieces of paper for one order.
 *
 * Built on the server rather than in the browser because the document is priced
 * from the parent order's exploded bill of materials, which the page does not
 * hold and which no client should be handed.
 *
 * Three documents, one order. `specification` is -1, what the factory builds
 * from; `shipping` is -2, the transport order, which books nothing and only
 * exists once the barriers do; `priced` is -3, the accounting document and the
 * only one of the three that needs cost.view.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { renderSupplierDocument, type SupplierDocumentKind } from '@/lib/bamida-po-document'

const Input = z.object({
  poId: z.string().uuid('Invalid PO id'),
  kind: z.enum(['specification', 'priced', 'shipping']),
})

export type SupplierPoPdfResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string }

export async function downloadSupplierPoPdf(input: {
  poId: string
  kind: SupplierDocumentKind
}): Promise<SupplierPoPdfResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('po.view')) {
    return { ok: false, error: 'Forbidden: missing po.view capability' }
  }
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { poId, kind } = parsed.data

  // Only the accounting document has figures on it. The specification has none
  // by construction, so the people who pick and pack can print it.
  if (kind === 'priced' && !auth.capabilities.has('cost.view')) {
    return { ok: false, error: 'Forbidden: the priced order needs cost.view' }
  }

  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false, error: 'That purchase order no longer exists.' }
  }

  const document = await renderSupplierDocument(poId, kind)
  if (!document.ok) {
    return {
      ok: false,
      error:
        document.reason === 'no_parent'
          ? 'This order has no parent order, so there is no bill of materials behind it.'
          : document.reason === 'no_shipment'
            ? 'There is no shipment request for this order yet. One is drafted when the barriers are finished.'
            : document.reason === 'no_bom'
              ? 'The bill of materials for this order could not be read.'
              : 'The bill of materials produced no lines for this order.',
    }
  }
  return document
}
