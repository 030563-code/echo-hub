'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { updateDealStage } from '@/app/actions/hubspot/updateDealStage'
import { getSalesProfileSettings } from '@/app/actions/sales/get-profile-settings'
import { HUBSPOT_PIPELINES, QUOTATION_ACCEPTED_STAGES, TENDER_STAGES } from '@/lib/hubspot-constants'
import { useRouter } from 'next/navigation'
import { ArrowRightLeft } from 'lucide-react'

interface ChangeStageDialogProps {
  dealId: string
  currentStageId: string
  pipelineId: string
}

export default function ChangeStageDialog({ dealId, currentStageId, pipelineId }: ChangeStageDialogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedStage, setSelectedStage] = useState(currentStageId)
  const [loading, setLoading] = useState(false)
  const [tenderDate, setTenderDate] = useState('')
  const [depotForAccepted, setDepotForAccepted] = useState('')
  const [allowedDepots, setAllowedDepots] = useState<string[]>([])
  const [depotsError, setDepotsError] = useState(false)
  const router = useRouter()

  useEffect(() => {
    async function fetchDepots() {
      const result = await getSalesProfileSettings()
      if (result.success && result.data) {
        setAllowedDepots(result.data.allowed_depots)
      } else {
        setDepotsError(true)
      }
    }
    fetchDepots()
  }, [])

  // Reset the conditional fields when the user picks a different stage.
  // Done in the change handler (not a setState-in-effect) to avoid cascading
  // renders (finding #26 / react-hooks/set-state-in-effect).
  const handleStageChange = (value: string) => {
    setSelectedStage(value)
    setTenderDate('')
    setDepotForAccepted('')
  }

  // Find the pipeline configuration
  const pipeline = Object.values(HUBSPOT_PIPELINES).find(p => p.id === pipelineId)

  if (!pipeline) return null // Don't show if pipeline not found

  const isTenderStage = TENDER_STAGES.includes(selectedStage)
  const isQuoteAcceptedStage = QUOTATION_ACCEPTED_STAGES.includes(selectedStage)
  const canUpdate =
    selectedStage !== currentStageId &&
    (!isTenderStage || tenderDate !== '') &&
    (!isQuoteAcceptedStage || depotForAccepted !== '')

  const handleUpdateStage = async () => {
    setLoading(true)
    const result = await updateDealStage(
      dealId,
      pipelineId,
      selectedStage,
      isQuoteAcceptedStage ? depotForAccepted : undefined,
      undefined,
      isTenderStage ? tenderDate : undefined
    )
    setLoading(false)

    if (result.success) {
      setIsOpen(false)
      router.refresh()
    } else {
      toast.error('Failed to update stage: ' + result.error)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setIsOpen(true)} className="border-gray-300 text-gray-700 hover:bg-gray-50">
        <ArrowRightLeft className="w-4 h-4 mr-2" />
        Change Stage
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[425px] bg-white text-gray-900 border-gray-200">
          <DialogHeader>
            <DialogTitle className="text-gray-900">Update Deal Stage</DialogTitle>
          </DialogHeader>

          <div className="py-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">Select New Stage</label>
              <Select value={selectedStage} onValueChange={handleStageChange}>
                <SelectTrigger className="bg-white border-gray-300 text-gray-900">
                  <SelectValue placeholder="Select stage..." />
                </SelectTrigger>
                <SelectContent className="bg-white border-gray-200 text-gray-900">
                  {Object.entries(pipeline.stages).map(([key, id]) => (
                    <SelectItem key={id} value={id} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                      {key.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isTenderStage && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-gray-700">Tender Date *</Label>
                <Input
                  type="date"
                  value={tenderDate}
                  onChange={(e) => setTenderDate(e.target.value)}
                  className="bg-white border-gray-300 text-gray-900"
                />
                <p className="text-xs text-gray-500">Required when moving to Tender stage.</p>
              </div>
            )}

            {isQuoteAcceptedStage && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-gray-700">Sending Depot *</Label>
                {depotsError ? (
                  <p className="text-sm text-red-600">Unable to load depots. Please refresh and try again.</p>
                ) : (
                  <Select value={depotForAccepted} onValueChange={setDepotForAccepted}>
                    <SelectTrigger className="bg-white border-gray-300 text-gray-900">
                      <SelectValue placeholder="Choose depot..." />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-gray-200 text-gray-900">
                      {allowedDepots.map((d) => (
                        <SelectItem key={d} value={d} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-gray-500">Required before marking as Quote Accepted.</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} className="border-gray-300 text-gray-700">
              Cancel
            </Button>
            <Button onClick={handleUpdateStage} disabled={loading || !canUpdate || (isQuoteAcceptedStage && depotsError)} className="bg-echo-yellow text-black hover:bg-echo-yellow/90">
              {loading ? 'Updating...' : isQuoteAcceptedStage && depotsError ? 'Depot Unavailable' : 'Update Stage'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
