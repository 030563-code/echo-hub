import { describe, it, expect } from 'vitest'
import { chainNumber, isFullyReceived } from '@/lib/po-number'

describe('chainNumber (PO-001 / PO-001-1 / PO-001-2 chain label, SRO-rooted)', () => {
  it('the intercompany order (depot + group→SRO legs) = the base number', () => {
    // depot and the SRO order are the same order at successive stages → both base.
    expect(chainNumber({ po_number: 'PO-01020', master_ref: 'MR-PO-01020', leg: 'DEPOT_TO_EB_GROUP' })).toBe('PO-01020')
    expect(chainNumber({ po_number: 'PO-01021', master_ref: 'MR-PO-01020', leg: 'EB_GROUP_TO_SRO' })).toBe('PO-01020')
  })
  it('Bamida child = base-1, Cargo child = base-2 (shared master_ref)', () => {
    expect(chainNumber({ po_number: 'PO-01022', master_ref: 'MR-PO-01020', leg: 'SRO_TO_SUPPLIER' })).toBe('PO-01020-1')
    expect(chainNumber({ po_number: 'PO-01023', master_ref: 'MR-PO-01020', leg: 'SRO_TO_CARGO' })).toBe('PO-01020-2')
  })
  it('falls back to the raw po_number (no suffix) when master_ref is null, on any leg', () => {
    expect(chainNumber({ po_number: 'PO-09000', master_ref: null, leg: 'DEPOT_TO_EB_GROUP' })).toBe('PO-09000')
    expect(chainNumber({ po_number: 'PO-09001', master_ref: null, leg: 'SRO_TO_CARGO' })).toBe('PO-09001')
  })
})

describe('isFullyReceived', () => {
  it('false when any line is short or there are no lines', () => {
    expect(isFullyReceived([])).toBe(false)
    expect(isFullyReceived([{ quantity: 10, qty_received: 5 }])).toBe(false)
    expect(isFullyReceived([{ quantity: 10, qty_received: 10 }, { quantity: 5 }])).toBe(false) // 2nd undefined → 0
  })
  it('true only when every line has received ≥ ordered', () => {
    expect(isFullyReceived([{ quantity: 10, qty_received: 10 }])).toBe(true)
    expect(isFullyReceived([{ quantity: 10, qty_received: 12 }, { quantity: 5, qty_received: 5 }])).toBe(true)
  })
})
