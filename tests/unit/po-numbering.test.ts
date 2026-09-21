import { describe, it, expect } from 'vitest'
import {
  PO_PREFIX_BY_DEPOT,
  chainNumber,
  depotHasPoSeries,
  isNewSchemePoNumber,
  poNumberPurpose,
  poPrefixForDepot,
  sroDocumentNumber,
} from '@/lib/po-number'
import { DEPOT_MAPPING } from '@/lib/depot-constants'
import { buildBamidaPo } from '@/lib/bamida-po'
import type { SroPoBom } from '@/lib/erp-types'

/**
 * The numbering scheme of 14 Sep 2026: EBUSA8001, EBCAN8001, EBFRA8001,
 * EBAUS8001 for depot orders, EBGRP8001 for Group orders, and EBSRO8001-1 /
 * -2 / -3 for s.r.o.'s documents under EBGRP8001.
 */

describe('depot to number series', () => {
  it('maps US depots to EBUSA, Canada to EBCAN, France to EBFRA, Australia to EBAUS', () => {
    expect(poPrefixForDepot('US-BAL')).toBe('EBUSA')
    expect(poPrefixForDepot('US-SBD')).toBe('EBUSA')
    expect(poPrefixForDepot('CA-HAM')).toBe('EBCAN')
    expect(poPrefixForDepot('EU-FR')).toBe('EBFRA')
    expect(poPrefixForDepot('AU-SYD')).toBe('EBAUS')
  })

  it('gives the UK depot its own series, not another country\'s', () => {
    // GB-BSE was refused until 21 Sep 2026. Dean asked for it, so it has EBUK
    // and a sequence of its own rather than borrowing EBUSA or EBFRA.
    expect(depotHasPoSeries('GB-BSE')).toBe(true)
    expect(poPrefixForDepot('GB-BSE')).toBe('EBUK')
  })

  it('refuses a depot with no series in plain words instead of borrowing a prefix', () => {
    // EB-SRO and EB-GROUP are absent on purpose: they raise their own legs and
    // take their numbers from those, not from a depot series.
    for (const depot of ['EU-SK', 'EB-SRO', 'EB-GROUP', 'US-NEW', 'EU-France', '']) {
      expect(depotHasPoSeries(depot)).toBe(false)
      expect(() => poPrefixForDepot(depot)).toThrow(/has no purchase order number series/)
    }
    expect(() => poPrefixForDepot('EU-SK')).toThrow(
      'Depot EU-SK has no purchase order number series. Depot orders can be raised for US-BAL, US-SBD, CA-HAM, EU-FR, GB-BSE, AU-SYD.',
    )
  })

  it('does not read inherited object keys as depots', () => {
    expect(depotHasPoSeries('toString')).toBe(false)
    expect(() => poPrefixForDepot('constructor')).toThrow()
  })

  it('only maps depot codes the Hub actually carries', () => {
    for (const depot of Object.keys(PO_PREFIX_BY_DEPOT)) {
      expect(Object.keys(DEPOT_MAPPING)).toContain(depot)
    }
  })
})

describe('poNumberPurpose', () => {
  it('reads the s.r.o. suffix as the document purpose', () => {
    expect(poNumberPurpose('EBSRO8001-1')).toBe('Manufacturing')
    expect(poNumberPurpose('EBSRO8001-2')).toBe('Shipping')
    expect(poNumberPurpose('EBSRO8001-3')).toBe('Accounting')
    expect(poNumberPurpose(' EBSRO8123-2 ')).toBe('Shipping')
  })

  it('is null for every number without an s.r.o. suffix', () => {
    for (const n of ['EBUSA8001', 'EBGRP8001', 'EBSRO8001', 'EBSRO8001-4', 'EBSRO2026001-01', 'PO-01224', 'PO-01224-1', '', null, undefined]) {
      expect(poNumberPurpose(n)).toBeNull()
    }
  })
})

describe('sroDocumentNumber', () => {
  it('derives the s.r.o. documents from the Group order number, as the database mint does', () => {
    expect(sroDocumentNumber('EBGRP8001', 'Manufacturing')).toBe('EBSRO8001-1')
    expect(sroDocumentNumber('EBGRP8001', 'Shipping')).toBe('EBSRO8001-2')
    expect(sroDocumentNumber('EBGRP8042', 'Accounting')).toBe('EBSRO8042-3')
  })

  it('is null under a Group order from before the scheme', () => {
    expect(sroDocumentNumber('PO-01224', 'Manufacturing')).toBeNull()
    expect(sroDocumentNumber('EBG26086', 'Shipping')).toBeNull()
    expect(sroDocumentNumber('EBUSA8001', 'Shipping')).toBeNull()
    expect(sroDocumentNumber(null, 'Shipping')).toBeNull()
  })
})

describe('isNewSchemePoNumber', () => {
  it('recognises every series in the scheme', () => {
    for (const n of ['EBUSA8001', 'EBCAN8001', 'EBFRA8001', 'EBAUS8001', 'EBGRP8001', 'EBSRO8001-1', 'EBSRO8001-2', 'EBSRO8001-3']) {
      expect(isNewSchemePoNumber(n)).toBe(true)
    }
  })

  it('leaves old Hub numbers and old Xero numbers out', () => {
    for (const n of ['PO-01224', 'PO-00001364', 'EBG26086', 'EBUSA26013x', 'EBSRO2026001-01', 'MRPD-20260914-01', '', null]) {
      expect(isNewSchemePoNumber(n)).toBe(false)
    }
  })
})

describe('chainNumber', () => {
  it('shows a new-scheme number as it is, on every leg', () => {
    expect(chainNumber({ po_number: 'EBUSA8001', master_ref: 'MR-EBUSA8001', leg: 'DEPOT_TO_EB_GROUP' })).toBe('EBUSA8001')
    expect(chainNumber({ po_number: 'EBGRP8001', master_ref: 'MR-EBUSA8001', leg: 'EB_GROUP_TO_SRO' })).toBe('EBGRP8001')
    expect(chainNumber({ po_number: 'EBSRO8001-1', master_ref: 'MR-EBUSA8001', leg: 'SRO_TO_SUPPLIER' })).toBe('EBSRO8001-1')
    expect(chainNumber({ po_number: 'EBSRO8001-2', master_ref: 'MR-EBUSA8001', leg: 'SRO_TO_CARGO' })).toBe('EBSRO8001-2')
    expect(chainNumber({ po_number: 'EBGRP8002', master_ref: null, leg: 'EB_GROUP_TO_SRO' })).toBe('EBGRP8002')
  })

  it('keeps the master_ref label for a chain that started before the scheme', () => {
    expect(chainNumber({ po_number: 'PO-01224', master_ref: 'MR-PO-01223', leg: 'EB_GROUP_TO_SRO' })).toBe('PO-01223')
    expect(chainNumber({ po_number: 'PO-01225', master_ref: 'MR-PO-01223', leg: 'SRO_TO_SUPPLIER' })).toBe('PO-01223-1')
    // A new Group order under an old depot order is itself new-scheme...
    expect(chainNumber({ po_number: 'EBGRP8003', master_ref: 'MR-PO-01300', leg: 'EB_GROUP_TO_SRO' })).toBe('EBGRP8003')
    // ...while an old Xero number keeps the label it had.
    expect(chainNumber({ po_number: 'EBG26086', master_ref: 'MR-EBUSA26013', leg: 'EB_GROUP_TO_SRO' })).toBe('EBUSA26013')
  })
})

describe('the Bamida manufacturing document number', () => {
  function sroOrder(po_number: string): SroPoBom {
    return {
      id: 'po-1',
      po_number,
      master_ref: 'MR-EBUSA8001',
      from_entity: 'EB-GROUP',
      to_entity: 'EB-SRO',
      approved_at: null,
      created_at: '2026-09-14T00:00:00Z',
      lines: [],
      bamida_total: 0,
      sro_total: 0,
    }
  }

  // The document is numbered after the manufacturing order that was actually
  // raised, not after a number derived from the SRO order. Deriving printed an
  // EBSRO<n>-1 on every SRO order, including the ones fulfilled from stock,
  // which have no manufacturing child and never will.
  it('is the manufacturing order number when one has been raised', () => {
    expect(buildBamidaPo(sroOrder('EBGRP8001'), '2026-09-14', undefined, 'EBSRO8001-1').poNumber).toBe('EBSRO8001-1')
  })

  it('is the SRO order number when no manufacturing order exists', () => {
    // Fulfilled from stock: no child, so nothing to name it after.
    expect(buildBamidaPo(sroOrder('EBGRP8001'), '2026-09-14').poNumber).toBe('EBGRP8001')
    expect(buildBamidaPo(sroOrder('EBGRP8001'), '2026-09-14', undefined, null).poNumber).toBe('EBGRP8001')
    expect(buildBamidaPo(sroOrder('EBGRP8001'), '2026-09-14', undefined, '  ').poNumber).toBe('EBGRP8001')
  })

  it('keeps its own number under a chain from before the scheme', () => {
    expect(buildBamidaPo(sroOrder('PO-01224'), '2026-09-14').poNumber).toBe('PO-01224')
    // An old chain's manufacturing child carries a PO- number of its own.
    expect(buildBamidaPo(sroOrder('PO-01224'), '2026-09-14', undefined, 'PO-01225').poNumber).toBe('PO-01225')
  })
})
