import { describe, it, expect } from 'vitest'
import { parseSpotIds, pickEta, pickLatestEvent, extractShipmentDetail } from '@/lib/cargo-parse'

describe('parseSpotIds (the /shipments/lookup body → SPOT IDs)', () => {
  it('returns the cleaned id list, sorted newest (highest) first for determinism', () => {
    expect(parseSpotIds(['240362822'])).toEqual(['240362822'])
    expect(parseSpotIds([' 1 ', '', null, '2'])).toEqual(['2', '1'])
    expect(parseSpotIds([111, 222])).toEqual(['222', '111'])
    expect(parseSpotIds(['235541471', '236598256'])).toEqual(['236598256', '235541471'])
  })
  it('returns [] for non-array / error bodies (→ found:false upstream)', () => {
    expect(parseSpotIds({ responseCode: 404, message: 'not found' })).toEqual([])
    expect(parseSpotIds(null)).toEqual([])
    expect(parseSpotIds('oops')).toEqual([])
    expect(parseSpotIds([])).toEqual([])
  })
})

describe('pickEta', () => {
  it('prefers the door delivery date, then the port-of-discharge ETA', () => {
    expect(pickEta({ routingInformation: { delivery: { estimatedDelivery: { date: '2026-07-01' } } } })).toBe('2026-07-01')
    expect(
      pickEta({ routingInformation: { routingPoints: [{ routingPointType: 'PORT_OF_DISCHARGE', estimatedArrival: { date: '2026-06-27' } }] } })
    ).toBe('2026-06-27')
  })
  it('does NOT fall back to an arbitrary last routing point, and never throws', () => {
    expect(pickEta({ routingInformation: { routingPoints: [{ routingPointType: 'PORT_OF_LOADING', estimatedArrival: { date: '2026-05-15' } }] } })).toBeUndefined()
    expect(pickEta({})).toBeUndefined()
    expect(pickEta(null)).toBeUndefined()
  })
})

describe('pickLatestEvent', () => {
  it('returns the most recent event by timestamp', () => {
    const d = {
      events: [
        { eventTypeName: 'Booking confirmed', eventTimestamp: { date: '2026-01-19', time: '11:54:00' } },
        { eventTypeName: 'Estimated arrival', eventTimestamp: { date: '2026-02-27', time: '06:00:00' } },
        { eventTypeName: 'Gate in', eventTimestamp: { date: '2026-02-05', time: '09:12:00' } },
      ],
    }
    expect(pickLatestEvent(d)).toEqual({ name: 'Estimated arrival', date: '2026-02-27' })
  })
  it('is undefined when there are no usable events', () => {
    expect(pickLatestEvent({})).toBeUndefined()
    expect(pickLatestEvent({ events: [{ eventTypeName: '' }] })).toBeUndefined()
    expect(pickLatestEvent(null)).toBeUndefined()
  })
})

describe('extractShipmentDetail', () => {
  it('pulls container / vessel / carrier / shipped / latest-event from a detail body', () => {
    const d = {
      containerDefinition: { containers: [{ containerNumber: 'DRYU9972900' }] },
      shipmentDetails: { shipmentTransportDetails: { vesselName: 'EVER MEGA', oceanCarrier: { name: 'ONE (ONEY)' } } },
      routingInformation: { pickup: { estimatedCargoReadiness: { date: '2026-04-23' } }, delivery: { estimatedDelivery: { date: '2026-07-01' } } },
      events: [{ eventTypeName: 'Gate in', eventTimestamp: { date: '2026-05-05', time: '09:00:00' } }],
    }
    expect(extractShipmentDetail(d)).toEqual({
      container_ref: 'DRYU9972900',
      eta: '2026-07-01',
      shipped_at: '2026-04-23',
      vessel: 'EVER MEGA',
      carrier: 'ONE (ONEY)',
      last_event: 'Gate in',
      last_event_at: '2026-05-05',
    })
  })
  it('returns all-undefined (never throws) on an empty body', () => {
    expect(extractShipmentDetail({})).toEqual({
      container_ref: undefined, eta: undefined, shipped_at: undefined, vessel: undefined, carrier: undefined,
      last_event: undefined, last_event_at: undefined,
    })
  })
})
