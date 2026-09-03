import { describe, expect, it } from 'vitest'
import {
  REP_AGENT_LABEL,
  REP_AGENT_PROPERTY,
  REP_AGENT_VALUES,
  isKnownRepAgent,
  repAgentFallbackOptions,
} from '@/lib/deal-properties'

describe('REP_AGENT_PROPERTY', () => {
  /**
   * Dean asked for `usa_rep_agents`. Verified live against portal 3882358 on
   * 2026-09-03: no property of that name exists, only the cloned one. This test
   * exists so the suffix is never "tidied up" into a property that would 400.
   */
  it('is the cloned property that actually exists on the portal', () => {
    expect(REP_AGENT_PROPERTY).toBe('usa_rep_agents__cloned_')
  })

  it('does not show HubSpot’s "(Cloned)" label to a rep', () => {
    expect(REP_AGENT_LABEL).not.toMatch(/Cloned/i)
  })
})

describe('REP_AGENT_VALUES', () => {
  /** The five live options, as returned by
   *  GET /crm/v3/properties/deals/usa_rep_agents__cloned_ on 2026-09-03. */
  it('matches the live option list, in display order', () => {
    expect(REP_AGENT_VALUES).toEqual([
      'D T Cores',
      'R C Banner',
      '5 Star Sales',
      'The Sullivan Group',
      'EB Own',
    ])
  })

  it('has no duplicates and no blanks', () => {
    expect(new Set(REP_AGENT_VALUES).size).toBe(REP_AGENT_VALUES.length)
    for (const value of REP_AGENT_VALUES) expect(value.trim()).not.toBe('')
  })
})

describe('repAgentFallbackOptions', () => {
  it('gives value === label, which is how the property is set up', () => {
    const options = repAgentFallbackOptions()
    expect(options).toHaveLength(REP_AGENT_VALUES.length)
    for (const option of options) expect(option.label).toBe(option.value)
  })
})

describe('isKnownRepAgent', () => {
  const options = repAgentFallbackOptions()

  it('recognises a live option', () => {
    expect(isKnownRepAgent('EB Own', options)).toBe(true)
  })

  it('trims before comparing', () => {
    expect(isKnownRepAgent('  EB Own  ', options)).toBe(true)
  })

  it('rejects blank and missing values', () => {
    expect(isKnownRepAgent('', options)).toBe(false)
    expect(isKnownRepAgent('   ', options)).toBe(false)
    expect(isKnownRepAgent(null, options)).toBe(false)
    expect(isKnownRepAgent(undefined, options)).toBe(false)
  })

  /** A deal can carry a value the property no longer offers, from an import or
   *  a since-deleted option. The select shows it as text rather than losing it,
   *  which is what this answer drives. */
  it('rejects a value the property no longer offers', () => {
    expect(isKnownRepAgent('Some Retired Agency', options)).toBe(false)
  })

  it('is case sensitive, because HubSpot option values are', () => {
    expect(isKnownRepAgent('eb own', options)).toBe(false)
  })
})
