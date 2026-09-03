/**
 * Columns and bucketing for the deals board.
 *
 * The Quotes module used to carry a "Pending" tab that painted every row with
 * one hardcoded grey badge reading "Pending", throwing the deal's real stage
 * away. Dean's words: the pending status does not exist in HubSpot any more and
 * the module must "switch over to have the correct deal stages straight from
 * hubspot such as tender etc. to avoid confusion", in the kanban shape the
 * Purchase Order board already uses. This module is the pure half of that.
 *
 * COLUMN ORDER COMES FREE, and it looks like an accident, so: the key order of
 * each pipeline's `stages` object in hubspot-constants.ts is HubSpot's own
 * displayOrder. Verified against the live API on 2026-09-02 for USA SALES,
 * where both list Quote Request, Call, Quotation sent, Closed lost, Closed won,
 * Passed to Distributor, Closed Won by Distributor, Closed Lost By Distributor,
 * Tender, Quotation Accepted, General pricing in exactly that sequence. So
 * Object.entries gives the right columns with no second table to keep in step.
 */

import {
  CLOSED_LOST_STAGES,
  CLOSED_WON_STAGES,
  HUBSPOT_PIPELINES,
  stageLabel,
} from '@/lib/hubspot-constants'

export interface BoardColumn {
  stageId: string
  label: string
  /** The KEY from the pipeline's stages record, so a caller can style a column
   *  by family without re-deriving it from the id. */
  stageKey: string
}

/**
 * The board's columns for one pipeline, in HubSpot displayOrder.
 *
 * An unknown or absent pipeline gives an empty array rather than a guess. The
 * board renders an explicit "pick a pipeline" state from that; inventing
 * columns from another region would silently show a rep the wrong workflow.
 */
export function boardColumns(pipelineId: string | null | undefined): BoardColumn[] {
  const id = String(pipelineId ?? '').trim()
  if (id === '') return []
  const pipeline = Object.values(HUBSPOT_PIPELINES).find((entry) => entry.id === id)
  if (!pipeline) return []
  return Object.entries(pipeline.stages).map(([stageKey, stageId]) => ({
    stageId,
    stageKey,
    label: stageLabel(id, stageId),
  }))
}

export interface BoardGroup<T> {
  column: BoardColumn
  deals: T[]
}

/** The trailing catch-all. Its empty stageId is what marks it as not a real
 *  HubSpot stage, so nothing tries to drop a card onto it. */
const OTHER_COLUMN: BoardColumn = { stageId: '', stageKey: 'OTHER', label: 'Other' }

/**
 * Bucket deals into the columns, preserving the order they arrive in (the
 * caller sorts, usually by last modified).
 *
 * A deal whose stage belongs to no column lands in a trailing "Other" rather
 * than vanishing. That happens for real: a deal moved to another pipeline in
 * HubSpot between the search and the render, and a board that quietly dropped
 * it would have a rep hunting for a deal the Hub had decided not to mention.
 * The column only appears when something needed it.
 */
export function groupDealsByStage<T extends { properties: { dealstage: string } }>(
  deals: readonly T[],
  columns: readonly BoardColumn[],
): BoardGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const column of columns) groups.set(column.stageId, [])

  const other: T[] = []
  for (const deal of deals ?? []) {
    const stageId = String(deal?.properties?.dealstage ?? '')
    const bucket = groups.get(stageId)
    if (bucket && stageId !== '') bucket.push(deal)
    else other.push(deal)
  }

  const out: BoardGroup<T>[] = columns.map((column) => ({
    column,
    deals: groups.get(column.stageId) ?? [],
  }))
  if (other.length > 0) out.push({ column: OTHER_COLUMN, deals: other })
  return out
}

/**
 * The two distributor outcomes live OUTSIDE the family arrays.
 *
 * Checked in hubspot-constants.ts on 2026-09-03: CLOSED_WON_STAGES holds
 * USA_SALES.stages.CLOSED_WON but not CLOSED_WON_DISTRIBUTOR, and
 * CLOSED_LOST_STAGES likewise omits CLOSED_LOST_DISTRIBUTOR. Both mean the deal
 * is finished, so they are added here rather than widened in those arrays,
 * which seven other call sites read for their own purposes.
 */
const DISTRIBUTOR_CLOSED_STAGES: readonly string[] = [
  HUBSPOT_PIPELINES.USA_SALES.stages.CLOSED_WON_DISTRIBUTOR,
  HUBSPOT_PIPELINES.USA_SALES.stages.CLOSED_LOST_DISTRIBUTOR,
]

/** True when the deal is finished, so the board can grey the column and the
 *  deal page can hide "Assign to contractor". */
export function isClosedStage(stageId: string | null | undefined): boolean {
  const id = String(stageId ?? '').trim()
  if (id === '') return false
  return (
    CLOSED_WON_STAGES.includes(id) ||
    CLOSED_LOST_STAGES.includes(id) ||
    DISTRIBUTOR_CLOSED_STAGES.includes(id)
  )
}

/**
 * The Closed Lost stage of a pipeline, or null when there is not exactly one.
 *
 * Used when a rep hands a deal to a contractor. Never guessed and never
 * resolved by preference order: closing a deal into the wrong stage is not
 * something anybody notices afterwards, and a pipeline with two candidates is
 * genuinely ambiguous. The key names differ across the fourteen pipelines,
 * which is why this matches on the key rather than on a label.
 */
const CLOSED_LOST_KEYS = ['CLOSED_LOST', 'CLOSED_LOST_SALE', 'LOST', 'DEAL_LOST', 'CLOSED_LOST_NO_HIRE']

export function closedLostStageFor(pipelineId: string | null | undefined): string | null {
  const id = String(pipelineId ?? '').trim()
  if (id === '') return null
  const pipeline = Object.values(HUBSPOT_PIPELINES).find((entry) => entry.id === id)
  if (!pipeline) return null
  const stages = pipeline.stages as Record<string, string>
  const keys = Object.keys(stages).filter((key) => CLOSED_LOST_KEYS.includes(key))
  return keys.length === 1 ? stages[keys[0]] : null
}
