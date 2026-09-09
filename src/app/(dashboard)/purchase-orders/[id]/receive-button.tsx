'use client'

// page-state: none (whether the dialog is open. The quantities inside it are
// typed and logged in one sitting, and the durable record is po_line_receipts.)

import { useState } from 'react'
import { PackageCheck } from 'lucide-react'
import ReceiveModal from '@/components/po/receive-modal'
import type { PurchaseOrder } from '@/lib/erp-types'

/**
 * Log a delivery against this order.
 *
 * The board keeps the modal's open state in its own drawer. On a page with one
 * order there is nothing to keep, so this is the whole of it: a button and the
 * same modal. Whether it may be shown at all is the caller's decision, taken
 * with exactly the board's condition.
 */
export default function ReceiveButton({ po }: { po: PurchaseOrder }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-echo-orange hover:bg-echo-orange-hover rounded-lg transition-colors"
      >
        <PackageCheck className="w-4 h-4" /> Log delivery
      </button>
      {open && <ReceiveModal po={po} onClose={() => setOpen(false)} />}
    </>
  )
}
