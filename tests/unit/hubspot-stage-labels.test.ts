import { describe, it, expect } from 'vitest'
import { HUBSPOT_PIPELINES, STAGE_LABELS_BY_ID, stageLabel } from '@/lib/hubspot-constants'

const USA = HUBSPOT_PIPELINES.USA_SALES

describe('stage labels', () => {
  it('never returns a raw stage id', () => {
    // The old getStageLabel fell through to the id whenever the pipeline or
    // stage was not found, so a deal that had moved pipelines rendered a
    // 36-character GUID in the rep's face.
    for (const pipeline of Object.values(HUBSPOT_PIPELINES)) {
      for (const id of Object.values(pipeline.stages)) {
        const label = stageLabel(pipeline.id, id)
        expect(label).not.toBe(id)
        expect(label.trim()).not.toBe('')
        expect(label).not.toMatch(/^[0-9a-f]{8}-/)
      }
    }
  })

  it('uses the verbatim HubSpot names for USA SALES', () => {
    // Verified live against the portal 2026-09-02. The lower-case "by" in
    // "Closed Won by Distributor" is exactly why a derived label will not do.
    expect(stageLabel(USA.id, USA.stages.QUOTE_REQUEST)).toBe('Quote Request')
    expect(stageLabel(USA.id, USA.stages.QUOTATION_SENT)).toBe('Quotation sent')
    expect(stageLabel(USA.id, USA.stages.CLOSED_LOST)).toBe('Closed lost')
    expect(stageLabel(USA.id, USA.stages.CLOSED_WON)).toBe('Closed won')
    expect(stageLabel(USA.id, USA.stages.PASSED_TO_DISTRIBUTOR)).toBe('Passed to Distributor')
    expect(stageLabel(USA.id, USA.stages.CLOSED_WON_DISTRIBUTOR)).toBe('Closed Won by Distributor')
    expect(stageLabel(USA.id, USA.stages.CLOSED_LOST_DISTRIBUTOR)).toBe('Closed Lost By Distributor')
    expect(stageLabel(USA.id, USA.stages.QUOTATION_ACCEPTED)).toBe('Quotation Accepted')
    expect(stageLabel(USA.id, USA.stages.GENERAL_PRICING)).toBe('General pricing')
  })

  it('title-cases the key for pipelines whose real labels are unverified', () => {
    const uk = HUBSPOT_PIPELINES.UK_SALES_NEW
    expect(stageLabel(uk.id, uk.stages.QUOTATION_SENT_LIVE)).toBe('Quotation Sent Live')
  })

  it('resolves a stage even when paired with the wrong pipeline id', () => {
    // A deal that changed pipeline still has to render something a person can
    // read, so the global map is tried before giving up.
    expect(stageLabel('not-a-pipeline', USA.stages.CLOSED_WON)).toBe('Closed won')
  })

  it('returns "Unknown stage" only for an id in no pipeline at all', () => {
    expect(stageLabel(USA.id, 'ffffffff-0000-0000-0000-000000000000')).toBe('Unknown stage')
    expect(stageLabel('nope', 'also-nope')).toBe('Unknown stage')
  })

  it('has one entry per stage, because ids do not collide across pipelines', () => {
    // STAGE_LABELS_BY_ID is a flat map, so a duplicate id would silently make
    // one pipeline's label win for another's stage.
    const all = Object.values(HUBSPOT_PIPELINES).flatMap((p) => Object.values(p.stages))
    expect(new Set(all).size).toBe(all.length)
    expect(Object.keys(STAGE_LABELS_BY_ID).length).toBe(all.length)
  })
})
