import { describe, it, expect } from 'vitest'
import { PIPELINE_CONFIG, TEAM_PIPELINE_MAP } from '@/lib/pipeline-config'
import { DEPOT_MAPPING } from '@/lib/depot-constants'

/**
 * Guards review finding #12: completeProfile derives an agent's allowed_depots
 * from PIPELINE_CONFIG. The whole system (product_depot_mapping, deals_registry
 * RLS, notify/enrich DB triggers) keys on the depot CODE (e.g. "US-BAL"), which
 * lives in `allowedDepots[].label`. If a depot label ever stops being a valid
 * code, onboarding silently breaks SKU restriction + enrichment + the webhook.
 */
describe('PIPELINE_CONFIG depot keys are canonical codes (finding #12 regression guard)', () => {
  const validCodes = new Set(Object.keys(DEPOT_MAPPING))

  for (const pipeline of PIPELINE_CONFIG) {
    it(`${pipeline.label}: every allowedDepots label is a known depot CODE`, () => {
      for (const depot of pipeline.allowedDepots) {
        expect(validCodes.has(depot.label), `${depot.label} not in DEPOT_MAPPING`).toBe(true)
      }
    })
  }

  it('every TEAM_PIPELINE_MAP target resolves to a real pipeline (or is the AU literal id)', () => {
    const pipelineIds = new Set(PIPELINE_CONFIG.map((p) => p.pipelineId))
    for (const target of Object.values(TEAM_PIPELINE_MAP)) {
      expect(pipelineIds.has(target)).toBe(true)
    }
  })
})
