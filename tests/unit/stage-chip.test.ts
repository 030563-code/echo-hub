import { describe, it, expect } from 'vitest'
import { stageChip, stageChipClass } from '@/lib/stage-chip'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

const USA = HUBSPOT_PIPELINES.USA_SALES.id
const S = HUBSPOT_PIPELINES.USA_SALES.stages

describe('stageChipClass', () => {
  it('gives each family its own colour', () => {
    expect(stageChipClass(S.CLOSED_WON)).toContain('green')
    expect(stageChipClass(S.CLOSED_LOST)).toContain('red')
    expect(stageChipClass(S.QUOTATION_ACCEPTED)).toContain('indigo')
    expect(stageChipClass(S.QUOTATION_SENT)).toContain('blue')
    expect(stageChipClass(S.PASSED_TO_DISTRIBUTOR)).toContain('purple')
    expect(stageChipClass(S.TENDER)).toContain('slate')
    expect(stageChipClass(S.QUOTE_REQUEST)).toContain('yellow')
  })

  it('falls back to grey for a stage in no family', () => {
    expect(stageChipClass(S.GENERAL_PRICING)).toContain('gray')
    expect(stageChipClass('')).toContain('gray')
  })
})

describe('stageChip', () => {
  it('shows HubSpot own stage name, not an invented status', () => {
    // The whole point of the module: /quotes/pending used to paint a Tender
    // deal grey and call it "Pending".
    expect(stageChip(USA, S.TENDER)).toEqual({ text: 'Tender', className: expect.stringContaining('slate') })
    expect(stageChip(USA, S.GENERAL_PRICING).text).toBe('General pricing')
  })

  it('never leaks a raw GUID for a stage it cannot place', () => {
    expect(stageChip(USA, 'cafebabe-0000-0000-0000-000000000000').text).toBe('Unknown stage')
  })
})
