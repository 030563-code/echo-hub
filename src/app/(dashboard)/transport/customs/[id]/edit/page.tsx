import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { loadCustomsBill } from '@/lib/customs/store.server'
import { packageFrom } from '@/lib/customs/view'
import { formatDate } from '@/lib/utils'
import ReadingEditor from './reading-editor'

/**
 * Correcting what Claude read off a Nippon Express bill.
 *
 * Dean, 24 Sep 2026: "Some of the things say need a look but theres no way to edit in the Hub."
 */

export const dynamic = 'force-dynamic'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function EditCustomsReadingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability('customs.manage')
  const { id } = await params
  if (!uuid.test(id)) notFound()
  const row = await loadCustomsBill(id)
  if (!row) notFound()
  const pkg = row.ocr_status === 'done' ? packageFrom(row.extraction) : null
  if (!pkg) redirect(`/transport/customs/${id}`)
  const status = (row.xero_status ?? '').toUpperCase()

  return (
    <div className="p-6">
      <Link
        href={`/transport/customs/${id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" /> Back to the bill
      </Link>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Correct the reading of {row.invoice_number ?? row.file_name}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {row.edited_at
            ? `Corrected before, on ${formatDate(row.edited_at)}. Claude's first reading is kept.`
            : "Claude's reading, as it came off the scan. It is kept when you save a correction."}
        </p>
      </div>
      <ReadingEditor
        billId={id}
        pkg={pkg}
        draftInXero={Boolean(row.xero_invoice_id) && (status === 'DRAFT' || status === 'SUBMITTED')}
      />
    </div>
  )
}
