'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Handshake } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmPanel } from '@/components/ui/confirm-panel'
import { assignDealToContractor } from '@/app/actions/sales/assign-to-contractor'

/**
 * Closing a deal because the customer bought through a contractor.
 *
 * The reason written to HubSpot is the fixed phrase "Assigned to Contractor"
 * plus whatever the rep types, so the reason field groups cleanly in reporting
 * while the specifics stay readable. Dean chose that shape over a contractor
 * picker: the useful detail is rarely just a company name.
 */
export function AssignContractorDialog({ dealId, dealName }: { dealId: string; dealName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await assignDealToContractor({ dealId, note })
      if (result.success) {
        setOpen(false)
        setNote('')
        toast.success(
          result.noteWritten
            ? 'Deal closed and the note is on its HubSpot timeline'
            : 'Deal closed. The timeline note could not be written, so add it in HubSpot.',
        )
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Handshake className="mr-1.5 h-4 w-4" />
        Assign to contractor
      </Button>
      <DialogContent className="sm:max-w-[480px] bg-white text-gray-900 border-gray-200">
        <DialogHeader>
          <DialogTitle className="text-gray-900">Assign to contractor</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="contractorNote" className="text-gray-900">
              Which contractor, and anything the team should know
            </Label>
            <Textarea
              id="contractorNote"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Assigned to United Rentals, they are raising the PO. Contact is Mike on the Baltimore branch."
              className="mt-1"
            />
            <p className="mt-1 text-xs text-gray-500">
              This goes on the deal as the closed-lost reason and as a note on its HubSpot timeline.
            </p>
          </div>

          <ConfirmPanel>
            <p className="font-medium">This closes the deal</p>
            <p className="mt-1">
              {dealName} moves to Closed lost in HubSpot with the reason &quot;Assigned to
              Contractor&quot;. The Hub picks the change up from HubSpot shortly afterwards.
            </p>
            <p className="mt-2">Raise the contractor own deal with Create deal as usual.</p>
          </ConfirmPanel>

          {error && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || note.trim().length === 0}>
            {pending ? 'Closing...' : 'Close as assigned'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
