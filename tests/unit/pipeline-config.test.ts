import { describe, it, expect } from 'vitest'
import {
  PIPELINE_CONFIG,
  TEAM_PIPELINE_MAP,
  teamsForPipeline,
  allowedCurrenciesForPipeline,
  quoteTemplateIdFor,
} from '@/lib/pipeline-config'
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

/**
 * The reverse map at quotes/create/[dealId]/page.tsx turns a HubSpot depot
 * NAME back into a code. Two depots sharing a display name would silently
 * collapse into one and seed the form with the wrong depot.
 */
describe('DEPOT_MAPPING display names are unique', () => {
  it('has no two codes sharing a name', () => {
    const names = Object.values(DEPOT_MAPPING)
    expect(new Set(names).size).toBe(names.length)
  })
})

/**
 * The currency picker is driven from here, and createDeal validates against
 * the same list before writing to the live CRM.
 */
describe('PIPELINE_CONFIG currencies', () => {
  // Enabled in the HubSpot portal, verified 2026-09-02. Writing a currency
  // outside this set is rejected by HubSpot.
  const portalEnabled = new Set(['AED', 'AUD', 'CAD', 'EUR', 'GBP', 'JPY', 'USD'])

  for (const pipeline of PIPELINE_CONFIG) {
    it(`${pipeline.label}: offers at least one portal-enabled currency`, () => {
      expect(pipeline.allowedCurrencies.length).toBeGreaterThan(0)
      for (const code of pipeline.allowedCurrencies) {
        expect(portalEnabled.has(code), `${code} is not enabled in the portal`).toBe(true)
      }
    })
  }

  it('USA SALES offers exactly USD and CAD', () => {
    const usa = PIPELINE_CONFIG.find((p) => p.label === 'USA SALES')
    expect(usa?.allowedCurrencies).toEqual(['USD', 'CAD'])
  })

  it('falls back to USD for an unknown pipeline rather than widening the list', () => {
    expect(allowedCurrenciesForPipeline('not-a-pipeline')).toEqual(['USD'])
    expect(allowedCurrenciesForPipeline(null)).toEqual(['USD'])
  })

  it('resolves the real list for a known pipeline', () => {
    expect(allowedCurrenciesForPipeline('dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc')).toEqual(['USD', 'CAD'])
  })
})

/**
 * taxRegionForTemplate only recognises US and CAN. A template value it does
 * not recognise prints the Dublin group address with no tax note, so this
 * config must match what live profiles actually carry.
 */
describe('USA SALES quote templates match what taxRegionForTemplate accepts', () => {
  it('offers US and CAN, not the unrecognised "default"', () => {
    const usa = PIPELINE_CONFIG.find((p) => p.label === 'USA SALES')
    expect(usa?.allowedTemplates.map((t) => t.value)).toEqual(['US', 'CAN'])
  })
})

describe('quote template ids', () => {
  it('maps the two USA templates verified in the portal', () => {
    expect(quoteTemplateIdFor('US')).toBe('454422093232')
    expect(quoteTemplateIdFor('CAN')).toBe('456904456263')
  })

  it('is forgiving about how the value is typed', () => {
    expect(quoteTemplateIdFor('  us ')).toBe('454422093232')
  })

  it('returns null rather than guessing for a template with no id', () => {
    // Publishing under another rep's branding is worse than refusing to
    // publish, and the association cannot be corrected after creation.
    expect(quoteTemplateIdFor('default')).toBeNull()
    expect(quoteTemplateIdFor('')).toBeNull()
    expect(quoteTemplateIdFor(null)).toBeNull()
  })
})

/**
 * teamsForPipeline inverts TEAM_PIPELINE_MAP so company search can be scoped to
 * a rep's region. Dean, 9 Sep 2026: "Jillian should only see her USA sales team
 * companies, those made under a person under her pipeline."
 */
describe('teamsForPipeline', () => {
  const USA = 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc'
  const EURO = 'd739df20-18b4-4e4b-b183-943038071da1'

  it('finds the one team behind USA SALES', () => {
    expect(teamsForPipeline(USA)).toEqual(['949190'])
  })

  it('returns EVERY team feeding a pipeline, not just the first', () => {
    // EURO SALES is fed by Europe, France and Spain. Returning one would hide
    // two thirds of that region's companies from a French rep.
    expect(teamsForPipeline(EURO)).toEqual(['32677', '570270', '592522'])
  })

  it('returns empty for a missing, blank or unknown pipeline', () => {
    // Every caller fails closed on empty. Returning something here would be
    // the difference between "no results" and "the whole portal".
    expect(teamsForPipeline(null)).toEqual([])
    expect(teamsForPipeline(undefined)).toEqual([])
    expect(teamsForPipeline('   ')).toEqual([])
    expect(teamsForPipeline('not-a-pipeline')).toEqual([])
  })

  it('covers every pipeline named in the map', () => {
    // Self-check: a pipeline added to the map without a team would silently
    // lock that whole region out of company search.
    for (const pipelineId of new Set(Object.values(TEAM_PIPELINE_MAP))) {
      expect(teamsForPipeline(pipelineId).length).toBeGreaterThan(0)
    }
  })
})
