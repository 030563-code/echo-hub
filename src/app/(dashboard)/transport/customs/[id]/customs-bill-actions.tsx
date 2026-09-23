'use client'

// page-state: none (buttons with their own spinner and message; nothing is typed)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, FileText, Loader2, RefreshCw, Upload } from 'lucide-react'
import {
  approveCustomsBill,
  customsPdfLink,
  retryCustomsDraft,
  retryCustomsReading,
  type CustomsActionResult,
} from '@/app/actions/customs/bills'

export function CustomsBillActions({
  billId,
  canApprove,
  canMakeDraft,
  canReadAgain,
  totalLabel,
}: {
  billId: string
  canApprove: boolean
  canMakeDraft: boolean
  canReadAgain: boolean
  totalLabel: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function run(name: string, action: () => Promise<CustomsActionResult>) {
    setMessage(null)
    setBusy(name)
    startTransition(async () => {
      try {
        const result = await action()
        if (result.success) {
          setMessage({ tone: 'ok', text: result.message })
          toast.success(result.message)
        } else {
          setMessage({ tone: 'error', text: result.error })
          toast.error(result.error)
        }
      } catch (error) {
        // Said here, never thrown: thrown inside a transition it replaces the page.
        console.error('customs action failed', error)
        setMessage({ tone: 'error', text: 'That did not go through. Please try again.' })
      } finally {
        setBusy(null)
        router.refresh()
      }
    })
  }

  async function openPdf() {
    setMessage(null)
    const result = await customsPdfLink(billId)
    if (result.success) window.open(result.url, '_blank', 'noopener,noreferrer')
    else setMessage({ tone: 'error', text: result.error })
  }

  const button =
    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50'

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Approve this bill? It is authorised in Xero for ${totalLabel}.`)) return
              run('approve', () => approveCustomsBill(billId))
            }}
            className={`${button} border-[#025945] bg-[#025945] text-white hover:bg-[#01442f]`}
          >
            {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve
          </button>
        )}
        {canMakeDraft && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run('draft', () => retryCustomsDraft(billId))}
            className={`${button} border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
          >
            {busy === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Make the draft in Xero
          </button>
        )}
        {canReadAgain && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run('read', () => retryCustomsReading(billId))}
            className={`${button} border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
          >
            {busy === 'read' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Read it again
          </button>
        )}
        <button type="button" onClick={openPdf} className={`${button} border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}>
          <FileText className="h-4 w-4" /> Open the PDF
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-sm ${message.tone === 'ok' ? 'text-emerald-800' : 'text-red-700'}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  )
}
