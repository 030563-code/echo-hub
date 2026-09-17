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
 * PRICED, always: this document has no price-free variant, which is why it asks
 * for cost.view as well as po.view. The order page falls back to the generic
 * document for anyone without it.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { renderBamidaPoDocument } from '@/lib/bamida-po-document'

const Input = z.object({ poId: z.string().uuid('Invalid PO id') })

export type SupplierPoPdfResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string }

export async function downloadSupplierPoPdf(input: { poId: string }): Promise<SupplierPoPdfResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('po.view')) {
    return { ok: false, error: 'Forbidden: missing po.view capability' }
  }
  if (!auth.capabilities.has('cost.view')) {
    return { ok: false, error: 'Forbidden: the supplier document is priced and needs cost.view' }
  }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const poId = parsed.data.poId

  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false, error: 'That purchase order no longer exists.' }
  }

  const document = await renderBamidaPoDocument(poId)
  if (!document.ok) {
    return {
      ok: false,
      error:
        document.reason === 'no_parent'
          ? 'This order has no parent order, so there is no bill of materials to price it from.'
          : document.reason === 'no_bom'
            ? 'The bill of materials for this order could not be read.'
            : 'The bill of materials produced no lines for this order.',
    }
  }
  return document
}
