/**
 * One stage chip for every surface that shows a deal.
 *
 * The colouring lived as a private function on the deal detail page while each
 * list page hardcoded its own badge, so /quotes/pending painted every row grey
 * and labelled it "Pending" regardless of whether the deal was at Tender or
 * General pricing. Dean's words: the pending status "does not exist in hubspot
 * anymore and must switch over to have the correct deal stages straight from
 * hubspot such as tender etc. to avoid confusion". Moving this here is what
 * lets the lists, the board and the detail page all say the same thing.
 *
 * Pure, so the family mapping is testable and cannot silently lose a stage.
 */

import {
  CLOSED_LOST_STAGES,
  CLOSED_WON_STAGES,
  DISTRIBUTOR_STAGES,
  QUOTATION_ACCEPTED_STAGES,
  QUOTATION_SENT_STAGES,
  QUOTE_REQUEST_STAGES,
  TENDER_STAGES,
  stageLabel,
} from '@/lib/hubspot-constants'

/**
 * Colour by stage FAMILY, reusing the arrays that already classify every
 * pipeline's stages. Moved verbatim from quotes/deals/[id]/page.tsx; the order
 * matters, because a stage can sit in more than one array and the first match
 * wins.
 */
export function stageChipClass(stageId: string): string {
  if (CLOSED_WON_STAGES.includes(stageId)) return 'bg-green-100 text-green-800 border-green-200'
  if (CLOSED_LOST_STAGES.includes(stageId)) return 'bg-red-100 text-red-800 border-red-200'
  if (QUOTATION_ACCEPTED_STAGES.includes(stageId)) return 'bg-indigo-100 text-indigo-800 border-indigo-200'
  if (QUOTATION_SENT_STAGES.includes(stageId)) return 'bg-blue-100 text-blue-800 border-blue-200'
  if (DISTRIBUTOR_STAGES.includes(stageId)) return 'bg-purple-100 text-purple-800 border-purple-200'
  if (TENDER_STAGES.includes(stageId)) return 'bg-slate-100 text-slate-800 border-slate-200'
  if (QUOTE_REQUEST_STAGES.includes(stageId)) return 'bg-yellow-100 text-yellow-800 border-yellow-200'
  return 'bg-gray-100 text-gray-700 border-gray-200'
}

/** The chip a list row or a board card renders: HubSpot's own stage name, in
 *  its family colour. Never a raw GUID and never an invented status. */
export function stageChip(pipelineId: string, stageId: string): { text: string; className: string } {
  return { text: stageLabel(pipelineId, stageId), className: stageChipClass(stageId) }
}
