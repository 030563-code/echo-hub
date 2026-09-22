import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { createServerClient } from '@/lib/supabase/server'
import { loadPricedEditor } from '@/app/actions/purchase-orders/priced-document'
import InfoHint from '@/components/ui/info-hint'
import PricedEditor from './priced-editor'

export const dynamic = 'force-dynamic'

/**
 * The -3 priced order for one manufacturing order, as a form.
 *
 * Dean, 22 Sep 2026: "where do they edit the priced PO?" The -1 has had its editor since 17 Sep;
 * the priced order was generated from the bill of materials with nowhere to change a price, add
 * a line or take one off. Martin hit it the same week.
 *
 * The document arrives filled in: Bamida's unit prices from the weekly snapshot, the packaging
 * counts from the signed -1. Everything on it can be changed, lines can be added and removed,
 * and what is saved is exactly what the -3 PDF prints from then on.
 *
 * cost.view to open, because every line is a price. Only supplier orders have one.
 */
export default async function PricedOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('po.view') || !auth.capabilities.has('cost.view')) notFound()
  if (!(await poChainHeldBy(id, auth.profile.organisations))) notFound()

  const supabase = await createServerClient()
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, po_number, leg')
    .eq('id', id)
    .maybeSingle<{ id: string; po_number: string | null; leg: string | null }>()
  if (!po || po.leg !== 'SRO_TO_SUPPLIER') notFound()

  const loaded = await loadPricedEditor({ poId: id })

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
          Priced order {loaded.ok ? loaded.state.documentNumber : ''}
          <InfoHint label="How to use this page" align="left">
            Check the prices and quantities, change anything this order needs, add or remove
            lines, then press Confirm. Confirm saves and signs in one go, so if it is already
            right you do not have to edit anything first. What you save is what the PDF prints.
          </InfoHint>
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          This is the accounting copy, Bamida&apos;s prices to Echo Barrier s.r.o. It is filled in
          from the bill of materials and the confirmed specification. Nothing on the printed
          document says whether it was checked; this page does.
        </p>
      </header>

      {loaded.ok ? (
        <PricedEditor poId={id} initial={loaded.state} />
      ) : (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {loaded.error}
        </p>
      )}
    </div>
  )
}
