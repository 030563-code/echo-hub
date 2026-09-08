import { createAdminClient } from '@/lib/supabase/admin'
import { resolveManufacturingToken } from '@/lib/manufacturing-token'
import { displayPoNumber } from '@/lib/po-number'
import SupplierPanel from './supplier-panel'

export const dynamic = 'force-dynamic'

/**
 * What Bamida see. Outside (dashboard) on purpose: no Hub navigation, no
 * session, no way through to anything else.
 *
 * THE NO-COST RULE IS ENFORCED BY THE QUERY, NOT BY THE MARKUP. The select
 * below names sku, product_name and quantity and nothing more, so unit_price,
 * cost_snapshot and sro_cost_snapshot_eur never reach this process, let alone
 * this page. Omitting them from the render would leave the money one careless
 * edit away from a supplier's screen.
 */
export default async function ManufacturingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveManufacturingToken(token)

  if (!resolved.ok) {
    const message =
      resolved.reason === 'expired'
        ? 'This link has expired.'
        : resolved.reason === 'revoked'
          ? 'This link has been withdrawn.'
          : 'This link is not valid.'
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900">{message}</h1>
        <p className="mt-2 text-sm text-gray-600">
          Please ask Echo Barrier to send you a new one. Nothing has been changed.
        </p>
      </Shell>
    )
  }

  const admin = createAdminClient()

  const [{ data: po }, { data: mfg }] = await Promise.all([
    admin
      .from('purchase_orders')
      .select('po_number, reference_po_number, created_at, lines:purchase_order_lines(sku, product_name, quantity)')
      .eq('id', resolved.poId)
      .maybeSingle(),
    admin
      .from('po_manufacturing')
      .select('est_start, est_finish, finished_at')
      .eq('po_id', resolved.poId)
      .maybeSingle(),
  ])

  if (!po) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900">This order is no longer available.</h1>
        <p className="mt-2 text-sm text-gray-600">Please contact Echo Barrier.</p>
      </Shell>
    )
  }

  const lines = (po.lines ?? []) as Array<{ sku: string | null; product_name: string | null; quantity: number | null }>

  return (
    <Shell>
      <p className="text-xs uppercase tracking-wider text-gray-500">Echo Barrier</p>
      <h1 className="mt-1 text-2xl font-bold text-gray-900">
        Purchase order {displayPoNumber(po.po_number)}
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        Tell us when you expect to start and finish, and press the button below once the barriers are
        made.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
              <th className="px-4 py-2.5 text-left font-medium">Code</th>
              <th className="px-4 py-2.5 text-left font-medium">Product</th>
              <th className="px-4 py-2.5 text-right font-medium">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-4 py-2.5 font-mono text-gray-900">{line.sku}</td>
                <td className="px-4 py-2.5 text-gray-600">{line.product_name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">{line.quantity}</td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                  This order has no lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SupplierPanel
        token={token}
        estStart={mfg?.est_start ?? null}
        estFinish={mfg?.est_finish ?? null}
        finishedAt={mfg?.finished_at ?? null}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        {children}
      </div>
    </main>
  )
}
