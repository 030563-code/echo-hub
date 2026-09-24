import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

/**
 * Where a deal goes once its quote has gone out.
 *
 * One rule for the two things that move a deal there: the rep's Mark as sent button
 * (markQuoteSent) and the Hub's own check on logged email (quote-sent/run.ts).
 */

function sentStageKeys(stages: Record<string, string>): string[] {
  return Object.keys(stages).filter((k) => k.includes('QUOTATION_SENT') || k.includes('QUOTATION_RECEIVED'))
}

/** The Quotation sent stage for a pipeline, by the same rule createQuote used:
 *  a stage key naming QUOTATION_SENT, or QUOTATION_RECEIVED where a pipeline
 *  calls it that. Null when the pipeline has neither, which is refused rather
 *  than guessed: HubSpot answers an unknown stage id with a 400. */
export function quotationSentStageFor(pipelineId: string): string | null {
  for (const key in HUBSPOT_PIPELINES) {
    const pipeline = HUBSPOT_PIPELINES[key as keyof typeof HUBSPOT_PIPELINES]
    if (pipeline.id !== pipelineId) continue
    const stages = pipeline.stages as Record<string, string>
    const stageKey = sentStageKeys(stages)[0]
    return stageKey ? stages[stageKey] : null
  }
  return null
}

/** The same stage, for the automatic move only, and only where there is exactly one.
 *  UK SALES - NEW has two (Price List and Live Requirement): which one a quote
 *  link means is the rep's call, so the check leaves those deals alone. */
export function automaticSentStageFor(pipelineId: string): string | null {
  for (const key in HUBSPOT_PIPELINES) {
    const pipeline = HUBSPOT_PIPELINES[key as keyof typeof HUBSPOT_PIPELINES]
    if (pipeline.id !== pipelineId) continue
    const stages = pipeline.stages as Record<string, string>
    const keys = sentStageKeys(stages)
    return keys.length === 1 ? stages[keys[0]] : null
  }
  return null
}
