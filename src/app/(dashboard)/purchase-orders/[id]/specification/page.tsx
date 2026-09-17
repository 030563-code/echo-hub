import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { createServerClient } from '@/lib/supabase/server'
import { displayPoNumber } from '@/lib/po-number'
import { loadSpecEditor } from '@/app/actions/purchase-orders/spec-document'
import InfoHint from '@/components/ui/info-hint'
import SpecificationEditor from './specification-editor'

export const dynamic = 'force-dynamic'

/**
 * The manufacturing specification for one order, as a form.
 *
 * Dean, 17 Sep 2026: "Juraj and Martin should really be able to edit all these PO's since theres
 * so many variables. It should be generated and prepopulated for him then he can edit and add
 * lines to these then it saves to the PO and prints properly. That way nothing goes unsigned."
 *
 * The document arrives filled in, from the order's bill of materials and the standing model
 * specifications. Everything on it can be changed, rows can be added and removed, and what is
 * saved is exactly what the -1 PDF prints from then on.
 *
 * Only supplier orders have one: the -1 IS the manufacturing order, and no other leg produces it.
 */
export default async function SpecificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('po.view')) notFound()
  if (!(await poChainHeldBy(id, auth.profile.organisations))) notFound()

  const supabase = await createServerClient()
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, po_number, leg')
    .eq('id', id)
    .maybeSingle<{ id: string; po_number: string | null; leg: string | null }>()
  if (!po || po.leg !== 'SRO_TO_SUPPLIER') notFound()

  const loaded = await loadSpecEditor({ poId: id })

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <Link
        href={`/purchase-orders/${id}`}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to the order
      </Link>

      <header className="mt-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-900">
          Manufacturing specification {displayPoNumber(po.po_number)}
          <InfoHint label="How to use this page" align="left">
            Read it, change anything this order needs, then press Confirm. Confirm saves and signs
            in one go, so if it is already right you do not have to edit anything first. Nothing
            can be sent to the factory until it is confirmed.
          </InfoHint>
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          This is what the factory builds from. It is filled in from the order and the standing
          product specifications; change anything on it, add the lines this order needs, then save
          and confirm it. What you save is what the PDF prints.
        </p>
      </header>

      {loaded.ok ? (
        <SpecificationEditor poId={id} initial={loaded.state} />
      ) : (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {loaded.error}
        </p>
      )}
    </div>
  )
}
