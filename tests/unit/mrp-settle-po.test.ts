import { describe, it, expect } from 'vitest'
import { buildDoorLeadTimeActuals } from '@/lib/mrp/settle-po'

describe('buildDoorLeadTimeActuals', () => {
  const nowIso = '2026-08-08T12:00:00Z'

  it('maps in-transit rows with usable shipped_at to door observations', () => {
    const rows = [
      { id: 'a', spot_id: 'SPOT-1', shipped_at: '2026-07-18' },        // bare date (live column is `date`)
      { id: 'b', spot_id: null, shipped_at: '2026-08-01T00:00:00Z' },
    ]
    expect(buildDoorLeadTimeActuals('po1', rows, nowIso)).toEqual([
      { po_id: 'po1', spot_id: 'SPOT-1', leg: 'door', days: 21.5 },
      { po_id: 'po1', spot_id: null, leg: 'door', days: 7.5 },
    ])
  })

  it('skips rows without shipped_at or with implausible spans (transitDays rules)', () => {
    const rows = [
      { id: 'a', spot_id: 'S', shipped_at: null },
      { id: 'b', spot_id: 'S', shipped_at: '2026-08-09' },   // negative span
      { id: 'c', spot_id: 'S', shipped_at: '2024-01-01' },   // >= 365d
      { id: 'd', spot_id: 'S', shipped_at: 'not-a-date' },
    ]
    expect(buildDoorLeadTimeActuals('po1', rows, nowIso)).toEqual([])
  })
})
